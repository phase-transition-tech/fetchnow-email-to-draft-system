export interface FakeXeroHandle {
  baseUrl: string;
  tokenUrl: string;
  state: {
    invoices: Map<string, { InvoiceID: string; Status: string; InvoiceNumber: string }>;
    attachments: { invoiceId: string; filename: string; bytes: number; contentType: string }[];
    calls: Record<string, unknown>[];
    tokenCalls: number;
    unauthorizedUsed: number;
    rateLimitUsed: number;
  };
  close(): Promise<void>;
  reset(): void;
  invoices(): { InvoiceID: string; Status: string; InvoiceNumber: string }[];
}

export function startFakeXero(opts?: {
  firstCallUnauthorized?: boolean;
  rateLimitOnce?: number | null;
  allowDuplicate?: boolean;
  existing?: Record<string, string>;
  requireBearer?: boolean;
}): Promise<FakeXeroHandle>;
