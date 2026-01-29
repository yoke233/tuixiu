export type StoredAttachment = {
  id: string;
  runId: string;
  mimeType: string;
  size: number;
  sha256: string;
  uri: string;
};

export type StoredAttachmentInfo = {
  id: string;
  runId: string;
  mimeType: string;
  size: number;
  sha256: string;
  filePath: string;
};

export interface AttachmentStore {
  putFromBase64(opts: { runId: string; mimeType: string; base64: string; name?: string | null }): Promise<StoredAttachment>;
  getInfo(opts: { runId: string; id: string }): Promise<StoredAttachmentInfo | null>;
  getBytes(opts: { runId: string; id: string }): Promise<Buffer | null>;
}

