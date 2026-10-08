export function buildPdfText(lines: string[]): Buffer;
export function buildPdfImage(width?: number, height?: number, rgb?: number[]): Buffer;
export function buildEml(input: {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  date: string;
  body: string;
  attachments?: { filename: string; contentType: string; buffer: Buffer }[];
}): string;
export function writeFixtures(dir: string): string[];
