export type Confidence = 'high' | 'medium' | 'low';
export type InvoiceStatus =
  | 'observed'
  | 'admitted'
  | 'retry'
  | 'extracting'
  | 'review'
  | 'created'
  | 'dead'
  | 'cancelled';

export type FlagCode =
  | 'AMOUNT_MISMATCH'
  | 'LINE_ITEM_SUM_MISMATCH'
  | 'TAX_RATE_UNEXPECTED'
  | 'DATE_UNCERTAIN'
  | 'DUE_DATE_MISSING'
  | 'MISSING_REQUIRED_FIELD'
  | 'OCR_NEEDED'
  | 'DUPLICATE_ATTACHMENT'
  | 'DUPLICATE_INVOICE_NO'
  | 'CURRENCY_UNSUPPORTED';

export interface Field<T> {
  value: T | null;
  confidence: Confidence;
  /** 溯源：能指回原图位置，出问题可翻回原发票核对 */
  source: string;
  raw?: string;
}

export interface LineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  lineAmount: number;
}

export interface InvoiceFields {
  vendor: Field<string>;
  invoiceNo: Field<string>;
  issueDate: Field<string>;
  dueDate: Field<string>;
  currency: Field<string>;
  subtotal: Field<number>;
  tax: Field<number>;
  total: Field<number>;
  taxType: 'Inclusive' | 'Exclusive';
  lineItems: LineItem[];
  /** 整个 PDF 的可读文本量，用来判断是不是扫描件 */
  textChars: number;
  extraction: 'native' | 'ocr' | 'none';
}

export interface ReviewFlag {
  code: FlagCode;
  severity: 'block' | 'warn';
  message: string;
}

export interface RawAttachment {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  path: string;
}

export interface RawMessage {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  source: string;
  /** 入库只认信封头；附件要等过滤判断完才落盘，所以这里不强制带 */
  attachments?: RawAttachment[];
}

export interface DraftBillInput {
  vendor: string;
  invoiceNo: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  lineAmountTypes: 'Inclusive' | 'Exclusive';
  lineItems: LineItem[];
  tax: number;
  total: number;
  taxCode: string;
  accountCode: string;
  attachmentPath: string;
  attachmentFilename: string;
  /** 真实附件 MIME：Xero 的附件端点要按字节流原样传，不能靠 JSON 推断 */
  attachmentContentType?: string;
  sourceMessageId: string;
}

export interface DraftBillResult {
  provider: string;
  billId: string;
  status: string;
  url?: string;
  /** 建单前查重命中：复用已有草稿，本次没有发出 POST */
  deduped?: boolean;
}

export interface XeroAdapter {
  readonly name: string;
  createDraftBill(input: DraftBillInput): Promise<DraftBillResult>;
}
