import type {
  MerchantBalance,
  WithdrawalAccountType,
  WithdrawalRecord,
  WithdrawalSettings,
  WithdrawalStatus,
} from "../shared/contracts";
import { getSetting, setSetting, type AppDatabase } from "./db";
import { AppError, assert } from "./errors";
import { calculateFee, formatFeeRate } from "./merchants";
import { centsToMoney, parseMoneyToCents, randomDigits } from "./security";

export const WITHDRAWAL_STATUSES: WithdrawalStatus[] = ["pending", "paid", "rejected", "cancelled"];

export function getWithdrawalSettings(database: AppDatabase): WithdrawalSettings {
  const feeRateBp = getSetting<number>(database, "withdraw_fee_rate_bp", 800);
  return {
    enabled: getSetting(database, "withdraw_enabled", true),
    fee_rate_bp: feeRateBp,
    fee_rate: formatFeeRate(feeRateBp),
    min_cents: getSetting<number>(database, "withdraw_min_cents", 100),
  };
}

export function updateWithdrawalSettings(database: AppDatabase, input: { enabled?: boolean; feeRateBp?: number; minCents?: number }) {
  if (input.enabled !== undefined) setSetting(database, "withdraw_enabled", input.enabled);
  if (input.feeRateBp !== undefined) {
    assert(Number.isInteger(input.feeRateBp) && input.feeRateBp >= 0 && input.feeRateBp <= 10_000, 400, "INVALID_FEE_RATE", "提现费率须为 0–100%");
    setSetting(database, "withdraw_fee_rate_bp", input.feeRateBp);
  }
  if (input.minCents !== undefined) {
    assert(Number.isInteger(input.minCents) && input.minCents >= 1, 400, "INVALID_MIN_AMOUNT", "最低提现金额须大于 0");
    setSetting(database, "withdraw_min_cents", input.minCents);
  }
  return getWithdrawalSettings(database);
}

/** Order income counts the merchant's requested amount minus the order fee snapshot. */
export function getMerchantBalance(database: AppDatabase, merchant: { id: string; pid: string }): MerchantBalance {
  const income = (database.query(`
    SELECT COALESCE(SUM(requested_amount_cents - fee_cents), 0) AS cents
    FROM orders WHERE pid = ? AND status IN ('paid', 'late_paid')
  `).get(merchant.pid) as { cents: number }).cents;
  const sums = database.query(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN total_cents ELSE 0 END), 0) AS frozen,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents ELSE 0 END), 0) AS withdrawn
    FROM withdrawals WHERE merchant_id = ?
  `).get(merchant.id) as { frozen: number; withdrawn: number };
  return {
    income_cents: income,
    frozen_cents: sums.frozen,
    withdrawn_cents: sums.withdrawn,
    available_cents: income - sums.frozen - sums.withdrawn,
  };
}

/** Largest amount whose amount + fee fits in `availableCents`. */
export function maxWithdrawable(availableCents: number, feeRateBp: number) {
  if (availableCents <= 0) return 0;
  let amount = Math.floor((availableCents * 10_000) / (10_000 + feeRateBp));
  while (amount > 0 && amount + calculateFee(amount, feeRateBp) > availableCents) amount -= 1;
  while (amount + 1 + calculateFee(amount + 1, feeRateBp) <= availableCents) amount += 1;
  return amount;
}

function createWithdrawNo() {
  return `W${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${randomDigits(4)}`;
}

export interface WithdrawalRequestInput {
  amount: string;
  accountType: string;
  accountNo: string;
  accountName: string;
  bankName?: string;
  note?: string;
}

/** Validates, then freezes amount + fee atomically against the current available balance. */
export function requestWithdrawal(database: AppDatabase, merchant: { id: string; pid: string }, input: WithdrawalRequestInput) {
  const settings = getWithdrawalSettings(database);
  assert(settings.enabled, 403, "WITHDRAW_DISABLED", "平台暂未开放提现");
  let amountCents: number;
  try {
    amountCents = parseMoneyToCents(input.amount);
  } catch (error) {
    throw new AppError(400, "INVALID_AMOUNT", error instanceof Error ? error.message : "金额格式错误");
  }
  assert(amountCents >= settings.min_cents, 400, "AMOUNT_TOO_SMALL", `单笔最低提现 ${centsToMoney(settings.min_cents)} 元`);
  assert(input.accountType === "alipay" || input.accountType === "bank", 400, "INVALID_ACCOUNT_TYPE", "收款方式须为支付宝或银行卡");
  const accountType = input.accountType as WithdrawalAccountType;
  const accountNo = input.accountNo.trim();
  const accountName = input.accountName.trim();
  const bankName = (input.bankName ?? "").trim();
  assert(accountNo.length >= 3 && accountNo.length <= 64, 400, "INVALID_ACCOUNT_NO", "收款账号须为 3–64 个字符");
  assert(accountName.length >= 1 && accountName.length <= 32, 400, "INVALID_ACCOUNT_NAME", "请填写收款人真实姓名");
  if (accountType === "bank") assert(bankName.length >= 2 && bankName.length <= 64, 400, "INVALID_BANK_NAME", "请填写开户银行");
  const feeCents = calculateFee(amountCents, settings.fee_rate_bp);
  const totalCents = amountCents + feeCents;

  database.exec("BEGIN IMMEDIATE");
  try {
    const balance = getMerchantBalance(database, merchant);
    assert(
      totalCents <= balance.available_cents,
      400,
      "INSUFFICIENT_BALANCE",
      `可用余额不足：本次需扣除 ${centsToMoney(totalCents)} 元（含手续费 ${centsToMoney(feeCents)} 元），可用 ${centsToMoney(Math.max(0, balance.available_cents))} 元`,
    );
    const id = crypto.randomUUID();
    database.query(`
      INSERT INTO withdrawals(
        id, withdraw_no, merchant_id, amount_cents, fee_rate_bp, fee_cents, total_cents, status,
        account_type, account_no, account_name, bank_name, merchant_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id, createWithdrawNo(), merchant.id, amountCents, settings.fee_rate_bp, feeCents, totalCents,
      accountType, accountNo, accountName, accountType === "bank" ? bankName : "", (input.note ?? "").trim().slice(0, 200),
      new Date().toISOString(),
    );
    database.exec("COMMIT");
    return getWithdrawal(database, id)!;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getWithdrawal(database: AppDatabase, id: string) {
  return database.query("SELECT * FROM withdrawals WHERE id = ?").get(id) as WithdrawalRecord | null;
}

/** Moves a pending withdrawal to a final state exactly once. */
function finalize(database: AppDatabase, id: string, status: Exclude<WithdrawalStatus, "pending">, fields: { reviewedBy: string; adminNote?: string; payoutRef?: string }, merchantId?: string) {
  const changed = database.query(`
    UPDATE withdrawals SET status = ?, reviewed_at = ?, reviewed_by = ?, admin_note = ?, payout_ref = ?
    WHERE id = ? AND status = 'pending' ${merchantId ? "AND merchant_id = ?" : ""}
  `).run(
    status, new Date().toISOString(), fields.reviewedBy, (fields.adminNote ?? "").trim().slice(0, 200), (fields.payoutRef ?? "").trim().slice(0, 128),
    id, ...(merchantId ? [merchantId] : []),
  ).changes;
  if (!changed) {
    const existing = getWithdrawal(database, id);
    assert(existing && (!merchantId || existing.merchant_id === merchantId), 404, "WITHDRAWAL_NOT_FOUND", "提现申请不存在");
    throw new AppError(409, "WITHDRAWAL_NOT_PENDING", "该提现申请已处理，不能重复操作");
  }
  return getWithdrawal(database, id)!;
}

/** Admin confirms the money was sent: the frozen amount + fee is now permanently deducted. */
export function markWithdrawalPaid(database: AppDatabase, id: string, reviewer: string, payoutRef?: string, adminNote?: string) {
  return finalize(database, id, "paid", { reviewedBy: reviewer, payoutRef, adminNote });
}

/** Admin rejects: the frozen amount returns to the available balance. */
export function rejectWithdrawal(database: AppDatabase, id: string, reviewer: string, reason: string) {
  assert(reason.trim(), 400, "REASON_REQUIRED", "请填写驳回原因");
  return finalize(database, id, "rejected", { reviewedBy: reviewer, adminNote: reason });
}

/** Merchant withdraws its own pending request. */
export function cancelWithdrawal(database: AppDatabase, id: string, merchantId: string) {
  return finalize(database, id, "cancelled", { reviewedBy: "merchant" }, merchantId);
}

export function listWithdrawals(database: AppDatabase, options: { merchantId?: string; status?: WithdrawalStatus; limit?: number; offset?: number } = {}) {
  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (options.merchantId) { where.push("w.merchant_id = ?"); bindings.push(options.merchantId); }
  if (options.status) { where.push("w.status = ?"); bindings.push(options.status); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const offset = Math.max(0, options.offset ?? 0);
  const data = database.query(`
    SELECT w.*, m.name AS merchant_name, m.pid AS merchant_pid
    FROM withdrawals w JOIN merchants m ON m.id = w.merchant_id
    ${clause} ORDER BY w.created_at DESC LIMIT ? OFFSET ?
  `).all(...bindings, limit, offset) as WithdrawalRecord[];
  const total = (database.query(`SELECT COUNT(*) AS count FROM withdrawals w ${clause}`).get(...bindings) as { count: number }).count;
  return { data, total, limit, offset };
}

export function pendingWithdrawalSummary(database: AppDatabase) {
  return database.query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS amount_cents FROM withdrawals WHERE status = 'pending'
  `).get() as { count: number; amount_cents: number };
}

/** Most recent payee details, to prefill the next request. */
export function lastWithdrawalAccount(database: AppDatabase, merchantId: string) {
  return database.query(`
    SELECT account_type, account_no, account_name, bank_name FROM withdrawals
    WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(merchantId) as Pick<WithdrawalRecord, "account_type" | "account_no" | "account_name" | "bank_name"> | null;
}
