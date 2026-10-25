import { resizeImage } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@pi-harness/shared";
import type { WorkbenchAttachment } from "@pi-harness/contracts";
import type { HarnessDatabase } from "../db/database.js";
export const MAX_ATTACHMENT_FILES = 6,
  MAX_TEXT_BYTES = 64 * 1024,
  MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
type Row = {
  id: string;
  workbench_id: string;
  name: string;
  kind: "text" | "image";
  mime_type: string;
  bytes: number;
  data: Buffer;
  request_id: string | null;
};
export class WorkbenchAttachments {
  constructor(private db: HarnessDatabase) {}
  clearAbandoned() {
    this.db
      .prepare(`DELETE FROM workbench_attachments WHERE request_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM composer_drafts d,json_each(d.body,'$.attachmentIds') j
          WHERE d.workbench_id=workbench_attachments.workbench_id AND j.value=workbench_attachments.id
        )`)
      .run();
  }
  private owner(id: string) {
    if (!this.db.prepare("SELECT 1 FROM workbenches WHERE id=?").get(id))
      throw Error("工作台任务不存在");
  }
  private row(id: string, attachmentId: string): Row {
    const row = this.db
      .prepare(
        "SELECT * FROM workbench_attachments WHERE workbench_id=? AND id=?",
      )
      .get(id, attachmentId) as Row | undefined;
    if (!row) throw Error("附件不存在或不属于当前任务");
    return row;
  }
  private meta(r: Row): WorkbenchAttachment {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      mimeType: r.mime_type,
      bytes: r.bytes,
    };
  }
  async add(input: {
    id: string;
    name: string;
    kind: "text" | "image";
    mimeType: string;
    data: string;
  }): Promise<WorkbenchAttachment> {
    this.owner(input.id);
    const name = input.name.trim();
    let mime = input.mimeType.toLowerCase();
    if (!name || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name))
      throw Error("附件名称无效，请使用普通文件名");
    if (
      !input.data ||
      input.data.length > 6291456 ||
      input.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
    )
      throw Error("附件内容无效");
    let data = Buffer.from(input.data, "base64");
    if (input.kind === "image") {
      if (data.length > MAX_IMAGE_BYTES)
        throw Error("图片超过 4.5 MB，请缩小后重新添加");
      const valid =
        mime === "image/png"
          ? data
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === "image/jpeg"
            ? data[0] === 255 && data[1] === 216 && data[2] === 255
            : mime === "image/gif"
              ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))
              : mime === "image/webp"
                ? data.subarray(0, 4).toString() === "RIFF" &&
                  data.subarray(8, 12).toString() === "WEBP"
                : false;
      if (!valid) throw Error("图片格式不匹配，仅支持 PNG、JPEG、GIF、WebP");
      const prepared = await resizeImage(data, mime);
      if (!prepared) throw Error("图片无法解码，请换用完整有效的图片");
      data = Buffer.from(prepared.data, "base64");
      mime = prepared.mimeType;
      this.owner(input.id);
    } else if (input.kind === "text") {
      if (data.length > MAX_TEXT_BYTES)
        throw Error("文本附件超过 64 KB，请精简或拆分");
      if (/\.(pdf|docx?|xlsx?|pptx?|zip|gz|exe|dmg|blend)$/i.test(name))
        throw Error("目前支持 UTF-8 文本和图片文件");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw Error("文本附件必须使用 UTF-8 编码");
      }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
        throw Error("文件包含二进制内容，请选择文本文件");
    } else throw Error("不支持的附件类型");
    const quota = this.db
      .prepare(
        "SELECT COUNT(*) n,COALESCE(SUM(bytes),0) bytes FROM workbench_attachments WHERE workbench_id=?",
      )
      .get(input.id) as { n: number; bytes: number };
    if (quota.n >= 64 || quota.bytes + data.length > 64 * 1024 * 1024)
      throw Error("此任务附件已达存储上限，请使用新任务或移除未发送附件");
    const row: Row = {
      id: uuidv7(),
      workbench_id: input.id,
      name,
      kind: input.kind,
      mime_type: input.kind === "text" ? "text/plain" : mime,
      bytes: data.length,
      data,
      request_id: null,
    };
    this.db
      .prepare(
        "INSERT INTO workbench_attachments(id,workbench_id,name,kind,mime_type,bytes,data,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.workbench_id,
        row.name,
        row.kind,
        row.mime_type,
        row.bytes,
        row.data,
        Date.now(),
      );
    return this.meta(row);
  }
  read(id: string, attachmentId: string) {
    const row = this.row(id, attachmentId);
    return { attachment: this.meta(row), data: row.data.toString("base64") };
  }
  discard(id: string, attachmentId: string) {
    const row = this.row(id, attachmentId);
    if (row.request_id) return { ok: true };
    this.db
      .prepare(
        "DELETE FROM workbench_attachments WHERE id=? AND workbench_id=?",
      )
      .run(attachmentId, id);
    return { ok: true };
  }
  bind(id: string, requestId: string, ids: string[]): WorkbenchAttachment[] {
    if (ids.length > MAX_ATTACHMENT_FILES || new Set(ids).size !== ids.length)
      throw Error("每次最多发送 6 个不重复的附件");
    const rows = ids.map((a) => this.row(id, a));
    if (
      rows.reduce((n, r) => n + r.bytes, 0) > 12 * 1024 * 1024 ||
      rows.filter((r) => r.kind === "text").reduce((n, r) => n + r.bytes, 0) >
        128 * 1024
    )
      throw Error("单次附件总量过大：文本最多 128 KB，全部附件最多 12 MB");
    for (const r of rows)
      this.db
        .prepare(
          "UPDATE workbench_attachments SET request_id=COALESCE(request_id,?) WHERE id=? AND workbench_id=?",
        )
        .run(requestId, r.id, id);
    return rows.map((r) => this.meta(r));
  }
  manifest(id: string, ids: string[]) {
    return ids.map((a) => this.meta(this.row(id, a)));
  }
  content(id: string, ids: string[]) {
    const rows = ids.map((a) => this.row(id, a));
    return {
      text: rows
        .filter((r) => r.kind === "text")
        .map((r) => ({
          name: r.name,
          content: new TextDecoder().decode(r.data),
        })),
      images: rows
        .filter((r) => r.kind === "image")
        .map((r) => ({
          type: "image" as const,
          data: r.data.toString("base64"),
          mimeType: r.mime_type,
        })),
    };
  }
}
