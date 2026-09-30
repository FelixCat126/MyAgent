import ExcelJS from "exceljs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  Footer,
  PageNumber,
  AlignmentType,
  ExternalHyperlink,
  BorderStyle,
  LineRuleType,
} from "docx";

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  depth?: number;
  ordered?: boolean;
  start?: number;
  url?: string;
};
const bodyFont =
  process.platform === "darwin"
    ? "PingFang SC"
    : process.platform === "win32"
      ? "Microsoft YaHei"
      : "Noto Sans CJK SC";
const wordFont = {
  ascii: "Arial",
  hAnsi: "Arial",
  eastAsia: bodyFont,
  cs: "Arial",
};
function columnWeights(n: Node): number[] {
  const rows = children(n).map((r) => children(r).map(text));
  return Array.from({ length: rows[0]?.length ?? 0 }, (_, i) =>
    Math.min(
      24,
      Math.max(
        12,
        ...rows.map((r) =>
          [...(r[i] ?? "")].reduce(
            (sum, c) => sum + (c.charCodeAt(0) > 255 ? 2 : 1),
            0,
          ),
        ),
      ),
    ),
  );
}
const parse = (s: string) =>
  unified().use(remarkParse).use(remarkGfm).parse(s) as unknown as Node;
const children = (n: Node) => n.children ?? [];
const text = (n: Node): string =>
  n.value ?? (n.type === "break" ? "\n" : children(n).map(text).join(""));
const safeLink = (url = "") => (/^(https?:|mailto:)/i.test(url) ? url : "");
const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function parseMarkdownTables(
  md: string,
): { name: string; rows: string[][] }[] {
  const result: { name: string; rows: string[][] }[] = [];
  let title = "";
  const walk = (n: Node) => {
    if (n.type === "heading") title = text(n);
    if (n.type === "table") {
      const rows = children(n).map((r) => children(r).map(text));
      const width = Math.max(...rows.map((r) => r.length));
      result.push({
        name: title || `Table${result.length + 1}`,
        rows: rows.map((r) => [...r, ...Array(width - r.length).fill("")]),
      });
    } else children(n).forEach(walk);
  };
  walk(parse(md));
  return result;
}

export function markdownToPlainText(md: string): string {
  const block = (n: Node): string => {
    if (n.type === "table")
      return children(n)
        .map((r) => children(r).map(text).join("\t"))
        .join("\n");
    if (n.type === "list")
      return children(n)
        .map(
          (r, i) =>
            `${n.ordered ? `${(n.start ?? 1) + i}.` : "•"} ${children(r).map(block).join("\n")}`,
        )
        .join("\n");
    if (["root", "blockquote"].includes(n.type))
      return children(n).map(block).join("\n\n");
    return text(n);
  };
  return block(parse(md));
}

export function markdownToCsv(md: string): string {
  const tables = parseMarkdownTables(md);
  if (!tables.length)
    throw new Error("CSV 需要表格数据，请提供明确的列名和数据行。");
  if (tables.length > 1)
    throw new Error("CSV 只能保存一张表，请选择单张表或使用 Excel。");
  const quote = (s: string) =>
    `"${(/^[\s]*[=+@-]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"`;
  return (
    "\uFEFF" + tables[0].rows.map((r) => r.map(quote).join(",")).join("\r\n")
  );
}

function numericValue(s: string): string | number {
  const normalized = /^-?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?%?$/.test(s) ? s.replace(/,/g, '') : s;
  // Preserve identifiers, leading zeros and values beyond Excel's precision.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?%?$/.test(normalized) && normalized.replace(/\D/g, '').length <= 15) {
    const value = Number(normalized.replace(/%$/, ''));
    if (Number.isFinite(value)) return normalized.endsWith('%') ? value / 100 : value;
  }
  return s;
}

export async function markdownToXlsxBuffer(md: string): Promise<Buffer> {
  const tables = parseMarkdownTables(md);
  if (!tables.length)
    throw new Error("Excel 需要表格数据，请让助手整理出列名和数据行后重试。");
  const wb = new ExcelJS.Workbook();
  wb.creator = "MyAgent";
  for (const [index, table] of tables.entries()) {
    const name =
      (table.name.replace(/[\\/*?:\[\]]/g, "_").slice(0, 24) || "Table") +
      ` ${index + 1}`;
    const sheet = wb.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1 }],
      pageSetup: {
        paperSize: 9,
        orientation: table.rows[0].length > 5 ? "landscape" : "portrait",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
    });
    table.rows.forEach((r, rowIndex) => {
      if (r.some((c) => c.length > 32767))
        throw new Error("单元格超过 Excel 的 32767 字符限制，请拆分内容。");
      const row = sheet.addRow(
        r.map((v, col) =>
          rowIndex === 0 ||
          /编号|编码|账号|电话|邮编|ID|code|phone/i.test(
            table.rows[0][col] ?? "",
          )
            ? v
            : numericValue(v),
        ),
      );
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.font = {
          name: bodyFont,
          size: 11,
          color: { argb: rowIndex === 0 ? "FFFFFFFF" : "FF243247" },
          bold: rowIndex === 0,
        };
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: {
            argb:
              rowIndex === 0
                ? "FF243B53"
                : rowIndex % 2
                  ? "FFF1F5F9"
                  : "FFFFFFFF",
          },
        };
        cell.border = {
          bottom: { style: "hair", color: { argb: "FFDCE3EB" } },
        };
        if (
          rowIndex &&
          typeof cell.value === "number" &&
          r[col - 1]?.endsWith("%")
        )
          cell.numFmt = "0.00%";
        else if (
          rowIndex &&
          typeof cell.value === "number" &&
          /\.\d+$/.test(r[col - 1] ?? "")
        )
          cell.numFmt =
            "0." + "0".repeat((r[col - 1].split(".")[1] ?? "").length);
      });
      if (rowIndex === 0) row.height = 30;
    });
    sheet.columns.forEach((col, i) => {
      col.width = Math.min(
        48,
        Math.max(
          14,
          ...table.rows.map(
            (r) =>
              [...(r[i] ?? "")].reduce(
                (w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1),
                0,
              ) + 3,
          ),
        ),
      );
    });
    sheet.eachRow((row, index) => {
      const lines = Math.max(
        ...table.rows[index - 1].map((value, col) =>
          value
            .split("\n")
            .reduce(
              (total, line) =>
                total +
                Math.max(
                  1,
                  Math.ceil(
                    [...line].reduce(
                      (n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1),
                      0,
                    ) /
                      ((sheet.getColumn(col + 1).width ?? 14) - 2),
                  ),
                ),
              0,
            ),
        ),
      );
      const height = Math.max(index === 1 ? 30 : 24, lines * 15 + 10);
      if (height > 409)
        throw new Error(
          "表格单元格内容过长，无法在 Excel 行高限制内完整显示，请拆成多行。",
        );
      row.height = height;
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: table.rows.length, column: table.rows[0].length },
    };
    sheet.pageSetup.printTitlesRow = "1:1";
    sheet.headerFooter.oddFooter = "&L" + name + "&R第 &P 页 / 共 &N 页";
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function inline(
  n: Node,
  style: { bold?: boolean; italics?: boolean; strike?: boolean } = {},
): (TextRun | ExternalHyperlink)[] {
  if (n.type === "link" && safeLink(n.url))
    return [
      new ExternalHyperlink({
        link: n.url!,
        children: [
          new TextRun({ text: text(n), font: wordFont, style: "Hyperlink" }),
        ],
      }),
    ];
  if (n.type === "break") return [new TextRun({ break: 1 })];
  if (n.value != null)
    return [
      new TextRun({
        text: n.value,
        font: wordFont,
        snapToGrid: false,
        ...style,
        ...(n.type === "inlineCode"
          ? { font: "Consolas", shading: { fill: "F1F5F9" } }
          : {}),
      }),
    ];
  return children(n).flatMap((c) =>
    inline(c, {
      ...style,
      ...(n.type === "strong" ? { bold: true } : {}),
      ...(n.type === "emphasis" ? { italics: true } : {}),
      ...(n.type === "delete" ? { strike: true } : {}),
    }),
  );
}
export async function plainMarkdownToDocxBuffer(md: string): Promise<Buffer> {
  const blocks = (nodes: Node[], level = 0): (Paragraph | Table)[] =>
    nodes.flatMap((n): (Paragraph | Table)[] => {
      if (n.type === "table")
        return [
          new Table({
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: "DCE3EB" },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: "DCE3EB" },
              left: { style: BorderStyle.SINGLE, size: 4, color: "DCE3EB" },
              right: { style: BorderStyle.SINGLE, size: 4, color: "DCE3EB" },
              insideHorizontal: {
                style: BorderStyle.SINGLE,
                size: 4,
                color: "DCE3EB",
              },
              insideVertical: {
                style: BorderStyle.SINGLE,
                size: 4,
                color: "DCE3EB",
              },
            },
            columnWidths: columnWeights(n).map((w) =>
              Math.round(
                (w / columnWeights(n).reduce((a, b) => a + b, 0)) * 9638,
              ),
            ),
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: children(n).map(
              (r, i) =>
                new TableRow({
                  tableHeader: i === 0,
                  cantSplit: true,
                  children: children(r).map(
                    (c) =>
                      new TableCell({
                        shading: {
                          fill:
                            i === 0 ? "E8EEF4" : i % 2 ? "F7F9FC" : "FFFFFF",
                        },
                        margins: {
                          top: 100,
                          bottom: 100,
                          left: 120,
                          right: 120,
                        },
                        children: [
                          new Paragraph({
                            children: inline(c, { bold: i === 0 }),
                            spacing: {
                              after: 0,
                              line: 290,
                              lineRule: LineRuleType.EXACT,
                            },
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
          new Paragraph({ text: "", spacing: { after: 80 } }),
        ];
      if (n.type === "heading")
        return [
          new Paragraph({
            children: inline(n),
            heading:
              n.depth === 1
                ? HeadingLevel.TITLE
                : n.depth === 2
                  ? HeadingLevel.HEADING_1
                  : n.depth === 3
                    ? HeadingLevel.HEADING_2
                    : HeadingLevel.HEADING_3,
            keepNext: true,
          }),
        ];
      if (n.type === "list")
        return children(n).flatMap((item, i) =>
          children(item).flatMap((c, j) =>
            c.type === "list"
              ? blocks([c], level + 1)
              : [
                  new Paragraph({
                    children: [
                      new TextRun(
                        j === 0
                          ? n.ordered
                            ? `${(n.start ?? 1) + i}. `
                            : "• "
                          : "",
                      ),
                      ...inline(c),
                    ],
                    indent: { left: 360 * (level + 1), hanging: 240 },
                    spacing: {
                      after: 100,
                      line: 320,
                      lineRule: LineRuleType.EXACT,
                    },
                  }),
                ],
          ),
        );
      if (n.type === "blockquote")
        return children(n).map(
          (c) =>
            new Paragraph({
              children: inline(c, { italics: true }),
              indent: { left: 360 },
              shading: { fill: "F1F5F9" },
            }),
        );
      if (n.type === "code")
        return (n.value ?? "").split("\n").map(
          (line) =>
            new Paragraph({
              children: [
                new TextRun({
                  text: line || " ",
                  font: "Consolas",
                  size: 19,
                }),
              ],
              shading: { fill: "F1F5F9" },
              spacing: { after: 0, line: 250 },
            }),
        );
      if (n.type === "thematicBreak")
        return [
          new Paragraph({
            text: "────────────────────",
            spacing: { before: 120, after: 120 },
          }),
        ];
      return [
        new Paragraph({
          children: inline(n),
          widowControl: true,
          spacing: { after: 160, line: 340, lineRule: LineRuleType.EXACT },
        }),
      ];
    });
  const doc = new Document({
    creator: "MyAgent",
    styles: {
      default: {
        document: {
          run: { font: wordFont, size: 22, color: "243247" },
          paragraph: { spacing: { after: 160, line: 320 } },
        },
        title: {
          run: { font: wordFont, size: 36, bold: true, color: "111827" },
          paragraph: { spacing: { before: 0, after: 300 } },
        },
        heading1: {
          run: { font: wordFont, size: 28, bold: true, color: "243B53" },
          paragraph: { spacing: { before: 300, after: 160 } },
        },
        heading2: {
          run: { font: wordFont, size: 24, bold: true, color: "243B53" },
          paragraph: { spacing: { before: 220, after: 120 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ["第 ", PageNumber.CURRENT, " 页"],
                    size: 18,
                    color: "64748B",
                  }),
                ],
              }),
            ],
          }),
        },
        children: blocks(children(parse(md))),
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export function markdownToHtml(md: string): string {
  const render = (n: Node): string => {
    const body = () => children(n).map(render).join("");
    switch (n.type) {
      case "root":
        return body();
      case "heading":
        return `<h${n.depth}>${body()}</h${n.depth}>`;
      case "paragraph":
        return `<p>${body()}</p>`;
      case "strong":
        return `<strong>${body()}</strong>`;
      case "emphasis":
        return `<em>${body()}</em>`;
      case "delete":
        return `<del>${body()}</del>`;
      case "link":
        return safeLink(n.url)
          ? `<a href="${escape(n.url!)}">${body()}</a>`
          : body();
      case "list":
        return n.ordered
          ? `<ol start="${n.start ?? 1}">${body()}</ol>`
          : `<ul>${body()}</ul>`;
      case "listItem":
        return `<li>${body()}</li>`;
      case "blockquote":
        return `<blockquote>${body()}</blockquote>`;
      case "code":
        return `<pre><code>${escape(n.value ?? "")}</code></pre>`;
      case "inlineCode":
        return `<code>${escape(n.value ?? "")}</code>`;
      case "break":
        return "<br>";
      case "thematicBreak":
        return "<hr>";
      case "table":
        return `<table><colgroup>${columnWeights(n)
          .map(
            (w) =>
              `<col style="width:${(w / columnWeights(n).reduce((a, b) => a + b, 0)) * 100}%">`,
          )
          .join("")}</colgroup><thead>${children(n)
          .slice(0, 1)
          .map(
            (r) =>
              "<tr>" +
              children(r)
                .map((c) => `<th>${render(c)}</th>`)
                .join("") +
              "</tr>",
          )
          .join("")}</thead><tbody>${children(n)
          .slice(1)
          .map(
            (r) =>
              "<tr>" +
              children(r)
                .map((c) => `<td>${render(c)}</td>`)
                .join("") +
              "</tr>",
          )
          .join("")}</tbody></table>`;
      case "tableCell":
        return body();
      default:
        return n.value != null ? escape(n.value) : body();
    }
  };
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
@page{size:A4;margin:20mm}*{box-sizing:border-box}body{font-family:'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#243247;font-size:11pt;line-height:1.65;margin:0;overflow-wrap:anywhere}h1{font-size:23pt;color:#111827;margin:0 0 22pt}h2{font-size:16pt;color:#243b53;margin:22pt 0 10pt}h3,h4,h5,h6{font-size:12pt;margin:16pt 0 8pt}h1,h2,h3,h4,h5,h6{break-after:avoid}p{margin:0 0 10pt;orphans:3;widows:3}table{border-collapse:collapse;width:100%;margin:12pt 0 18pt;font-size:10pt;table-layout:fixed}thead{display:table-header-group}th,td{border:1px solid #dce3eb;padding:7pt 9pt;text-align:left;vertical-align:top}th{background:#e8eef4;font-weight:600}tbody tr:nth-child(even){background:#f7f9fc}tr{break-inside:avoid}pre{background:#f1f5f9;padding:12pt;white-space:pre-wrap;overflow-wrap:anywhere;font-size:9pt}code{font-family:Consolas,monospace;background:#f1f5f9}blockquote{border-left:3px solid #94a3b8;margin:12pt 0;padding:5pt 12pt;color:#526176}li{margin:4pt 0}li p{margin:0}a{color:#245b86;text-decoration:underline}hr{border:0;border-top:1px solid #dce3eb;margin:18pt 0}
</style><body>${render(parse(md))}</body></html>`;
}
