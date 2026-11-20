export type ApiVersion = "v1" | "v2";
export type CollectionMode = "business_qr" | "transfer";
export type TransferLinkLayer = 1 | 2 | 3;
export type OrderStatus = "pending" | "expired" | "paid" | "late_paid";

export const PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS = 5;
export const PAYMENT_POLL_INTERVAL_MIN_SECONDS = 1;
export const PAYMENT_POLL_INTERVAL_MAX_SECONDS = 60;

export interface OrderRecord {
  id: string;
  trade_no: string;
  pid: string;
  api_version: ApiVersion;
  out_trade_no: string;
  type: "alipay";
  name: string;
  requested_amount_cents: number;
  payable_amount_cents: number;
  collection_mode: CollectionMode;
  notify_url: string;
  return_url: string | null;
  param: string;
  client_ip: string;
  checkout_token: string;
  status: OrderStatus;
  created_at: string;
  expires_at: string;
  monitor_until: string;
  paid_at: string | null;
  alipay_account_log_id: string | null;
  alipay_order_no: string | null;
  buyer: string;
  fee_rate_bp: number;
  fee_cents: number;
  /** Set when the buyer was blacklisted; such an order can never be marked paid. */
  blocked_at: string | null;
  merchant_name?: string;
}

export interface DashboardData {
  today_order_count: number;
  today_paid_count: number;
  today_paid_cents: number;
  today_fee_cents: number;
  merchant_count: number;
  pending_withdrawal_count: number;
  pending_count: number;
  late_paid_count: number;
  notify_failed_count: number;
  unmatched_payment_count: number;
  active_monitors: number;
  last_scan: ScanRun | null;
  recent_orders: OrderRecord[];
  configured: boolean;
  collection_mode: CollectionMode;
}

export interface ScanRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "error" | "skipped";
  active_orders: number;
  pages: number;
  records: number;
  matched: number;
  error: string | null;
  trace_id: string | null;
}

export interface PublicSettings {
  setup_completed: boolean;
  public_base_url: string;
  collection_mode: CollectionMode;
  transfer_link_layer: TransferLinkLayer;
  payment_poll_interval_seconds: number;
  business_qr_url: string;
  alipay_app_id: string;
  alipay_endpoint: string;
  alipay_configured: boolean;
  v1_enabled: boolean;
  v2_enabled: boolean;
  v2_platform_public_key: string;
  allow_private_callbacks: boolean;
}

export interface CheckoutData {
  trade_no: string;
  out_trade_no: string;
  name: string;
  requested_money: string;
  payable_money: string;
  collection_mode: CollectionMode;
  status: OrderStatus;
  created_at: string;
  expires_at: string;
  monitor_until: string;
  payment_poll_interval_seconds: number;
  payment_uri: string;
  business_qr_url: string;
  return_url: string | null;
  return_target: string | null;
  /** The merchant acknowledged the async notification, so its order page already reflects the payment. */
  notify_delivered: boolean;
  /** The buyer is blacklisted: no payment details are returned. */
  blocked: boolean;
}

export type BlacklistKind = "ip" | "alipay_account";

export interface BlacklistEntry {
  id: string;
  kind: BlacklistKind;
  /** IP or CIDR for "ip"; the account exactly as Alipay bills show it for "alipay_account". */
  value: string;
  note: string;
  hits: number;
  last_hit_at: string | null;
  created_by: string;
  created_at: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export interface PeriodStats {
  order_count: number;
  paid_count: number;
  paid_cents: number;
  fee_cents: number;
  net_cents: number;
}

export interface MerchantStats {
  today: PeriodStats;
  yesterday: PeriodStats;
  last_7_days: PeriodStats;
  total: PeriodStats;
}

export interface MerchantSummary {
  id: string;
  pid: string;
  name: string;
  username: string | null;
  login_enabled: boolean;
  status: "active" | "disabled";
  fee_rate_bp: number;
  /** Percent string, e.g. "0.6". */
  fee_rate: string;
  v1_key_masked: string;
  v2_public_key: string;
  remark: string;
  created_at: string;
  updated_at: string;
  stats?: MerchantStats;
}

export type WithdrawalStatus = "pending" | "paid" | "rejected" | "cancelled";
export type WithdrawalAccountType = "alipay" | "bank";

/** All amounts in cents. available = income − withdrawn − frozen. */
export interface MerchantBalance {
  /** Net income from paid orders (order amount − order fee). */
  income_cents: number;
  /** Amount + fee of pending withdrawals. */
  frozen_cents: number;
  /** Amount + fee of paid-out withdrawals. */
  withdrawn_cents: number;
  available_cents: number;
}

export interface WithdrawalSettings {
  enabled: boolean;
  fee_rate_bp: number;
  /** Percent string, e.g. "8". */
  fee_rate: string;
  min_cents: number;
}

export interface WithdrawalRecord {
  id: string;
  withdraw_no: string;
  merchant_id: string;
  merchant_name?: string;
  merchant_pid?: string;
  /** What the merchant receives. */
  amount_cents: number;
  fee_rate_bp: number;
  fee_cents: number;
  /** amount + fee: frozen while pending, deducted once paid. */
  total_cents: number;
  status: WithdrawalStatus;
  account_type: WithdrawalAccountType;
  account_no: string;
  account_name: string;
  bank_name: string;
  merchant_note: string;
  admin_note: string;
  payout_ref: string;
  created_at: string;
  reviewed_at: string | null;
}
