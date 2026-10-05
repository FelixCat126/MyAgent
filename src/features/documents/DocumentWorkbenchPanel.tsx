import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FiX, FiDownload, FiEdit3, FiFileText, FiRotateCcw, FiChevronLeft, FiChevronRight, FiStopCircle } from 'react-icons/fi';
import type { FileInfo } from '../../types/message';
import type { DocumentFormat } from '../../types/document';
import { useI18n } from '../../hooks/useI18n';
import type { DataCalculationResult, DataStep, DocumentWorkbenchAPI, WorkbenchDocument } from './types';
import { DOCUMENT_WORKBENCH_OPEN } from './events';

const control = 'rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs outline-none focus:border-primary-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 disabled:opacity-50';
const button = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium hover:bg-stone-100 disabled:opacity-40 dark:hover:bg-slate-700';
type Compare = { left: string; right: string; leftLabel: string; rightLabel: string };
export function DocumentWorkbenchPanel() {
  const { locale } = useI18n(); const en = locale === 'en'; const label = (zh: string, english: string) => en ? english : zh;
  const [file, setFile] = useState<FileInfo | null>(null); const [doc, setDoc] = useState<WorkbenchDocument | null>(null);
  const [draft, setDraft] = useState(''); const [cellEdits, setCellEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'preview' | 'edit' | 'versions' | 'data'>('preview');
  const [page, setPage] = useState(1); const [pageImage, setPageImage] = useState(''); const [sheet, setSheet] = useState(''); const [range, setRange] = useState('');
  const [compare, setCompare] = useState<Compare | null>(null); const [leftVersion, setLeftVersion] = useState('');
  const [result, setResult] = useState<DataCalculationResult | null>(null); const [steps, setSteps] = useState<DataStep[]>([]);
  const [operation, setOperation] = useState<'filter' | 'dedupe' | 'group' | 'yoy'>('group'); const [column, setColumn] = useState(''); const [otherColumn, setOtherColumn] = useState(''); const [filterValue, setFilterValue] = useState(''); const [chartType, setChartType] = useState<'none' | 'bar' | 'line'>('none');
  const [secondFormat, setSecondFormat] = useState(false);
  const request = useRef(''); const epoch = useRef(0);
  const api = () => window.electron as unknown as DocumentWorkbenchAPI;
  const cancel = useCallback(() => { if (request.current) api().cancelDocumentOperation(request.current); request.current = ''; epoch.current++; setBusy(false); }, []);
  const run = async <T,>(task: (id: string) => Promise<T>, accept: (result: T) => void) => {
    cancel(); const generation = epoch.current; const id = crypto.randomUUID(); request.current = id; setBusy(true); setError(''); setNotice('');
    try { const response = await task(id); if (epoch.current !== generation) return; accept(response); }
    catch (e) { if (epoch.current === generation) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (epoch.current === generation) { setBusy(false); request.current = ''; } }
  };
  const acceptDocument = (next: WorkbenchDocument) => { setDoc(next); setDraft(next.content); setCellEdits({}); setSheet(next.table?.sheet ?? ''); setLeftVersion(next.versions[0]?.id ?? ''); setCompare(null); setPage(1); setPageImage(''); };
  const inspect = async (nextFile: FileInfo, selectedSheet?: string, selectedRange?: string) => {
    await run((id) => api().inspectDocument({ path: nextFile.path, name: nextFile.name, sheet: selectedSheet || undefined, range: selectedRange || undefined, requestId: id }), (r) => { if (r.ok) acceptDocument(r.document); else if (!r.canceled) setError(r.error); });
  };
  useEffect(() => {
    const open = (event: Event) => {
      const next = (event as CustomEvent<FileInfo>).detail;
      if (!next?.path || !next.name) return;
      cancel(); setFile(next); setDoc(null); setDraft(''); setTab('preview'); setPage(1); setPageImage(''); setRange(''); setResult(null); setSteps([]); setSecondFormat(false);
      void inspect(next);
    };
    window.addEventListener(DOCUMENT_WORKBENCH_OPEN, open);
    return () => { window.removeEventListener(DOCUMENT_WORKBENCH_OPEN, open); if (request.current) api().cancelDocumentOperation(request.current); epoch.current++; };
    // The event always opens a fresh document; no render state is used by the handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const active = doc?.versions.find((v) => v.id === doc.activeVersionId);
  useEffect(() => {
    if (doc?.kind !== 'pdf' || !active?.file.path || tab !== 'preview') return;
    const id = crypto.randomUUID(); let mounted = true; setPageImage('');
    void api().renderDocumentPage({ path: active.file.path, page, requestId: id }).then((r) => { if (mounted) { if (r.ok) setPageImage(r.image); else if (!r.canceled) setError(r.error); } }).catch((e) => { if (mounted) setError(String(e)); });
    return () => { mounted = false; api().cancelDocumentOperation(id); };
  }, [active?.file.path, doc?.kind, page, tab]);
  if (!file) return null;
  const dirty = Boolean(doc) && (draft !== doc!.content || Object.keys(cellEdits).length > 0);
  const close = () => { if (dirty && !window.confirm(label('未保存的编辑会丢弃，确定关闭？', 'Discard unsaved edits and close?'))) return; cancel(); setFile(null); };
  const save = async () => {
    if (!doc) return;
    const table = Boolean(doc.table); const formats: DocumentFormat[] = table ? secondFormat && doc.sheets?.length === 1 ? ['xlsx', 'csv'] : ['xlsx'] : ['docx', 'pdf'].includes(doc.kind) ? secondFormat ? ['docx', 'pdf'] : [doc.kind === 'pdf' ? 'pdf' : 'docx'] : secondFormat ? ['md', 'pdf'] : [doc.kind === 'txt' ? 'txt' : 'md'];
    const cells = table ? Object.entries(cellEdits).map(([address, value]) => { const previous = doc.table?.rows.flat().find((c) => c.address === address)?.value; const typed = typeof previous === 'number' && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value === '' ? null : value; return { sheet: doc.table!.sheet, address, value: typed }; }) : undefined;
    await run((id) => api().saveDocumentVersion({ documentId: doc.id, baseVersionId: doc.activeVersionId, content: table ? undefined : draft, cells, formats, requestId: id }), (r) => { if (r.ok) { acceptDocument(r.document); setTab('preview'); setNotice(label(`已保存为新版本，生成 ${r.files.length} 个文件。`, `New version saved; ${r.files.length} files created.`)); } else if (!r.canceled) setError(r.error); });
  };
  const download = async (path: string, name: string) => {
    const response = await window.electron.saveLocalFileCopy({ sourcePath: path, defaultFileName: name }); if (!response.ok && !response.canceled) setError(response.error ?? label('保存失败', 'Save failed'));
  };
  const columns = doc?.table?.rows[0]?.map((c, i) => String(c.value ?? '').trim() || doc.table!.columns[i]) ?? [];
  const addStep = () => {
    if (!column) { setError(label('请选择列', 'Choose a column')); return; }
    const step: DataStep = operation === 'filter' ? { op: 'filter', column, operator: 'eq', value: filterValue } : operation === 'dedupe' ? { op: 'dedupe', columns: [column] } : operation === 'group' ? { op: 'group', by: [column], aggregates: [{ column: otherColumn, function: 'sum', as: `${otherColumn}_sum` }] } : { op: 'yoy', yearColumn: column, valueColumn: otherColumn, as: 'YoY' };
    if ((operation === 'group' || operation === 'yoy') && !otherColumn) { setError(label('请选择数值列', 'Choose a numeric column')); return; }
    setSteps((s) => [...s, step]); setError('');
  };
  const calculate = async () => {
    if (!active || !doc?.table) return;
    const chartColumns = steps.some((s) => s.op === 'group') ? [column, `${otherColumn}_sum`] : [column, otherColumn];
    await run((id) => api().calculateDocumentData({ path: active.file.path, sheet: doc.table!.sheet, range: range || undefined, steps, chart: chartType === 'none' ? undefined : { type: chartType, x: chartColumns[0], y: chartColumns[1] }, requestId: id }), (r) => { if (r.ok) setResult(r.result); else if (!r.canceled) setError(r.error); });
  };
  return (
    <aside role="dialog" aria-modal="true" aria-label={label('文档工作台', 'Document workbench')} className="fixed inset-y-0 right-0 z-[80] flex w-[min(820px,100vw)] flex-col border-l border-stone-200 bg-stone-50 text-stone-800 shadow-2xl dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-5 py-4 dark:border-slate-700 dark:bg-slate-900">
        <FiFileText className="shrink-0 text-primary-500" size={21} /><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{doc?.title ?? file.name}</h2><p className="mt-1 text-[11px] text-stone-500 dark:text-slate-400">{label('预览 · 编辑 · 版本 · 计算', 'Preview · Edit · Versions · Compute')}</p></div>
        {active && (active.exports ?? [active.file]).map((exported) => <button key={exported.path} className={button} onClick={() => void download(exported.path, exported.name)} title={`${label('下载当前版本', 'Download current version')} ${exported.name}`}><FiDownload /><span className="text-[10px]">{exported.name.split('.').pop()?.toUpperCase()}</span></button>)}
        <button className={button} onClick={close} aria-label={label('关闭文档工作台', 'Close document workbench')}><FiX size={18} /></button>
      </header>
      <div className="flex gap-1 border-b border-stone-200 px-4 py-2 dark:border-slate-800">{(['preview', 'edit', 'versions', 'data'] as const).filter((name) => name !== 'edit' || doc?.editable).filter((name) => name !== 'data' || doc?.table).map((name) => <button key={name} disabled={!doc || busy} onClick={() => setTab(name)} className={`${button} ${tab === name ? 'bg-primary-500/10 text-primary-600 dark:text-primary-300' : ''}`}>{name === 'preview' ? label('预览', 'Preview') : name === 'edit' ? label('编辑', 'Edit') : name === 'versions' ? label('版本', 'Versions') : label('数据计算', 'Compute')}</button>)}<span className="flex-1" />{busy && <button className={`${button} text-rose-500`} onClick={cancel}><FiStopCircle />{label('取消', 'Cancel')}</button>}</div>
      {error && <div role="alert" className="mx-4 mt-3 rounded-lg bg-rose-100 p-3 text-xs text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">{error}</div>}
      {notice && <div role="status" className="mx-4 mt-3 rounded-lg bg-emerald-100 p-3 text-xs text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">{notice}</div>}
      {doc?.sourceMissing && <p className="px-5 pt-3 text-xs text-amber-600 dark:text-amber-300">{label('源文件已删除；此处读取保留的版本快照。', 'Source deleted; showing the preserved snapshot.')}</p>}
      {busy && !doc && <p role="status" className="p-6 text-sm text-stone-500">{label('正在本地解析，扫描件会执行离线 OCR…', 'Reading locally; scanned pages use offline OCR…')}</p>}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {doc?.table && (tab === 'preview' || tab === 'edit') && <>
          <div className="mb-4 flex flex-wrap items-center gap-2"><select className={control} value={sheet} disabled={busy || dirty} onChange={(e) => { setSheet(e.target.value); void inspect(file, e.target.value, range); }}>{doc.sheets?.map((s) => <option key={s}>{s}</option>)}</select><input className={control} placeholder="A1:D100" value={range} disabled={busy || dirty} onChange={(e) => setRange(e.target.value)} /><button className={button} disabled={busy || dirty} onClick={() => void inspect(file, sheet, range)}>{label('读取范围', 'Read range')}</button><span className="text-xs text-stone-500">{doc.table.range}</span></div>
          <div className="overflow-auto rounded-xl border border-stone-200 dark:border-slate-700"><table className="w-full border-collapse text-xs"><thead><tr className="bg-stone-100 dark:bg-slate-800"><th className="p-2">#</th>{doc.table.columns.map((c) => <th key={c} className="min-w-24 border-l border-stone-200 p-2 dark:border-slate-700">{c}</th>)}</tr></thead><tbody>{doc.table.rows.map((row) => <tr key={row[0]?.address} className="border-t border-stone-200 dark:border-slate-700"><th className="p-2 text-stone-400">{row[0]?.address.match(/\d+/)?.[0]}</th>{row.map((c) => <td key={c.address} className="max-w-64 border-l border-stone-200 p-2 dark:border-slate-700" title={`${doc.table!.sheet}!${c.address}${c.formula ? ` =${c.formula}` : ''}`}>{tab === 'edit' ? <input aria-label={`${doc.table!.sheet}!${c.address}`} className="w-full min-w-20 bg-transparent outline-none focus:bg-primary-500/10" disabled={busy} value={cellEdits[c.address] ?? String(c.value ?? '')} onChange={(e) => setCellEdits((s) => ({ ...s, [c.address]: e.target.value }))} /> : <span className="block truncate">{String(c.value ?? '')}</span>}</td>)}</tr>)}</tbody></table></div>
          {doc.table.truncated && <p className="mt-3 text-xs text-amber-600">{label('预览只显示部分数据；计算前请指定完整范围。', 'Preview is partial; specify a complete range for computation.')}</p>}{doc.table.warnings.map((w) => <p key={w} className="mt-2 text-xs text-amber-600 dark:text-amber-300">{w}</p>)}
        </>}
        {doc && !doc.table && tab === 'preview' && (doc.kind === 'pdf' ? <>
          <div className="mb-4 flex items-center justify-between"><button disabled={page <= 1} className={button} onClick={() => setPage((p) => p - 1)}><FiChevronLeft /></button><span className="text-xs">{label('第', 'Page')} {page} / {doc.pages?.length ?? '?'}</span><button disabled={page >= (doc.pages?.length ?? 1)} className={button} onClick={() => setPage((p) => p + 1)}><FiChevronRight /></button></div>
          {pageImage ? <img className="mx-auto w-full rounded-md bg-white shadow" src={pageImage} alt={label(`PDF 第 ${page} 页`, `PDF page ${page}`)} /> : <p className="py-12 text-center text-xs text-stone-500">{label('正在渲染页面…', 'Rendering page…')}</p>}
          <details className="mt-4 rounded-xl border border-stone-200 p-4 dark:border-slate-700"><summary className="cursor-pointer text-xs font-semibold">{label('提取文字与识别质量', 'Extracted text & recognition quality')}</summary>{doc.pages?.map((p) => <section key={p.page} className="mt-4"><p className={`text-xs font-medium ${p.method === 'failed' ? 'text-rose-500' : 'text-stone-500 dark:text-slate-400'}`}>{label('页', 'Page')} {p.page} · {p.method}{p.confidence !== undefined ? ` · ${Math.round(p.confidence)}%` : ''}</p><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-6">{p.warning ? `[${p.warning}]\n` : ''}{p.error || p.text}</pre></section>)}</details>
        </> : <article className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown></article>)}
        {doc && !doc.table && tab === 'edit' && <><p className="mb-3 text-xs leading-5 text-stone-500 dark:text-slate-400">{doc.editNotice || label('修改需要的段落，保存会创建新文件。', 'Edit paragraphs; saving creates a new file.')}</p><textarea aria-label={label('文档正文', 'Document body')} className="h-[60vh] w-full resize-y rounded-xl border border-stone-300 bg-white p-4 font-mono text-xs leading-6 outline-none focus:border-primary-400 dark:border-slate-600 dark:bg-slate-900" disabled={busy} value={draft} onChange={(e) => setDraft(e.target.value)} /></>}
        {doc && tab === 'edit' && <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-xl border border-stone-200 bg-white/95 p-3 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95"><label className="flex flex-1 items-center gap-2 text-xs"><input type="checkbox" checked={secondFormat} disabled={busy || Boolean(doc.table && doc.sheets && doc.sheets.length > 1)} onChange={(e) => setSecondFormat(e.target.checked)} />{doc.table ? label('同时导出 CSV', 'Also export CSV') : doc.kind === 'pdf' ? label('同时导出 Word', 'Also export Word') : label('同时导出 PDF', 'Also export PDF')}</label><button className={`${button} bg-primary-500 text-white hover:bg-primary-600`} disabled={busy || !dirty} onClick={() => void save()}><FiEdit3 />{label('保存新版本', 'Save new version')}</button></div>}
        {doc && tab === 'versions' && <>
          <p className="mb-4 text-xs text-stone-500">{label('恢复会建立新版本，历史文件始终保留。', 'Restore creates a new version; history is preserved.')}</p>
          {doc.versions.slice().reverse().map((v) => <div key={v.id} className="mb-2 flex items-center gap-2 rounded-xl border border-stone-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{v.label}{v.id === doc.activeVersionId ? ` · ${label('当前', 'Current')}` : ''}</p><p className="mt-1 text-[11px] text-stone-400">{new Date(v.createdAt).toLocaleString(en ? 'en-US' : 'zh-CN')} · {v.format.toUpperCase()}</p></div><button className={button} onClick={() => void download(v.file.path, v.file.name)}><FiDownload /></button><button className={button} disabled={busy || v.id === doc.activeVersionId} onClick={() => { if (dirty && !window.confirm(label('恢复会丢弃未保存的编辑，确定恢复？', 'Discard unsaved edits and restore?'))) return; void run((id) => api().restoreDocumentVersion({ documentId: doc.id, versionId: v.id, requestId: id }), (r) => { if (r.ok) { acceptDocument(r.document); setNotice(label('已恢复为一个新版本。', 'Restored as a new version.')); } else if (!r.canceled) setError(r.error); }); }}><FiRotateCcw />{label('恢复', 'Restore')}</button></div>)}
          <div className="mt-5 flex gap-2"><select aria-label={label('比较版本', 'Compare version')} className={`${control} min-w-0 flex-1`} value={leftVersion} onChange={(e) => setLeftVersion(e.target.value)}>{doc.versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select><button className={button} disabled={busy || !leftVersion} onClick={() => void run(() => api().compareDocumentVersions({ documentId: doc.id, leftId: leftVersion, rightId: doc.activeVersionId }), (r) => { if (r.ok) setCompare(r); else setError(r.error); })}>{label('与当前比较', 'Compare with current')}</button></div>
          {compare && <div className="mt-4 grid grid-cols-2 gap-3">{[{ title: compare.leftLabel, content: compare.left, other: compare.right }, { title: compare.rightLabel, content: compare.right, other: compare.left }].map((side, i) => <div key={i} className="overflow-hidden rounded-lg border border-stone-200 dark:border-slate-700"><h3 className="bg-stone-100 p-2 text-xs dark:bg-slate-800">{side.title}</h3><pre className="max-h-[45vh] overflow-auto p-3 text-[11px] leading-6">{side.content.split('\n').map((line, n) => <span key={n} className={`block whitespace-pre-wrap break-words ${side.other.split('\n')[n] !== line ? 'bg-amber-200/40 dark:bg-amber-700/30' : ''}`}>{line || ' '}</span>)}</pre></div>)}</div>}
        </>}
        {doc?.table && tab === 'data' && <>
          <p className="mb-4 text-xs leading-6 text-stone-500 dark:text-slate-400">{label('运算在本机执行；第一行作为列名，最多 10,000 行。公式使用已有计算值，无缓存会明确提示。', 'Computed locally; first row is the header, up to 10,000 rows. Formulas use cached values and report missing results.')}</p>
          <div className="flex flex-wrap gap-2"><select className={control} value={operation} onChange={(e) => setOperation(e.target.value as typeof operation)}><option value="group">{label('分组求和', 'Group & sum')}</option><option value="filter">{label('筛选相等', 'Filter equals')}</option><option value="dedupe">{label('去重', 'Dedupe')}</option><option value="yoy">{label('同比', 'Year over year')}</option></select><select aria-label={label('分组/筛选/年份列', 'Group/filter/year column')} className={control} value={column} onChange={(e) => setColumn(e.target.value)}><option value="">{label('选择列', 'Choose column')}</option>{columns.map((c) => <option key={c}>{c}</option>)}</select>{operation === 'filter' ? <input className={control} placeholder={label('筛选值', 'Filter value')} value={filterValue} onChange={(e) => setFilterValue(e.target.value)} /> : operation !== 'dedupe' && <select aria-label={label('数值列', 'Numeric column')} className={control} value={otherColumn} onChange={(e) => setOtherColumn(e.target.value)}><option value="">{label('数值列', 'Numeric column')}</option>{columns.map((c) => <option key={c}>{c}</option>)}</select>}<button className={button} disabled={busy || steps.length >= 20} onClick={addStep}>{label('加入步骤', 'Add step')}</button></div>
          <ol className="my-4 space-y-2">{steps.map((s, i) => <li key={i} className="flex items-center gap-2 rounded-lg bg-stone-100 p-2 dark:bg-slate-800"><span className="flex-1 break-words text-xs">{describeStep(s, en)}</span><button className={button} disabled={busy} aria-label={label(`删除第 ${i + 1} 步`, `Remove step ${i + 1}`)} onClick={() => setSteps((a) => a.filter((_, n) => n !== i))}><FiX /></button></li>)}</ol>
          <div className="flex gap-2"><input className={`${control} min-w-0 flex-1`} placeholder={label('可选完整范围，如 A1:D500', 'Optional complete range, e.g. A1:D500')} value={range} onChange={(e) => setRange(e.target.value)} /><select className={control} value={chartType} onChange={(e) => setChartType(e.target.value as typeof chartType)}><option value="none">{label('不生成图表', 'No chart')}</option><option value="bar">{label('柱状图', 'Bar chart')}</option><option value="line">{label('折线图', 'Line chart')}</option></select><button className={`${button} bg-primary-500 text-white`} disabled={busy || dirty} onClick={() => void calculate()}>{label('执行计算', 'Run calculation')}</button></div>
          {result && <div className="mt-5"><p className="text-xs text-stone-500">{result.rows.length} {label('行结果', 'result rows')} · {result.source.sheet}!{result.source.range}</p>{result.chartSvg && <img className="mt-3 w-full rounded-xl bg-white" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.chartSvg)}`} alt={label('计算结果图表', 'Computed chart')} />}<div className="mt-3 flex flex-wrap gap-2">{result.files.map((f) => <button key={f.path} className={`${button} border border-stone-200 dark:border-slate-700`} onClick={() => void download(f.path, f.name)}><FiDownload />{f.name}</button>)}</div>{result.warnings.map((w) => <p key={w} className="mt-2 text-xs text-amber-600 dark:text-amber-300">{w}</p>)}<div className="mt-4 overflow-auto rounded-lg border border-stone-200 dark:border-slate-700"><table className="w-full text-xs"><thead><tr>{result.columns.map((c) => <th key={c} className="bg-stone-100 p-2 text-left dark:bg-slate-800">{c}</th>)}</tr></thead><tbody>{result.rows.slice(0, 200).map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c} className="border-t border-stone-200 p-2 dark:border-slate-700">{String(r[c] ?? '')}</td>)}</tr>)}</tbody></table></div></div>}
        </>}
      </div>
      {doc && <footer className="border-t border-stone-200 px-5 py-3 text-[11px] text-stone-500 dark:border-slate-800 dark:text-slate-400">{doc.versions.length} {label('个版本 · 原文件保留', 'versions · Original preserved')}{doc.truncated ? ` · ${label('正文有截断', 'Content truncated')}` : ''}</footer>}
    </aside>
  );
}

function describeStep(step: DataStep, en: boolean): string {
 switch (step.op) {
  case 'filter': return en ? `Filter ${step.column}: ${step.operator} ${String(step.value)}` : `筛选 ${step.column}：${step.operator === 'eq' ? '等于' : step.operator} ${String(step.value)}`;
  case 'dedupe': return en ? `Remove duplicates by ${(step.columns ?? []).join(', ') || 'all columns'}` : `按 ${(step.columns ?? []).join('、') || '所有列'} 去重`;
  case 'group': return en ? `Group by ${step.by.join(', ') || 'all rows'}; ${step.aggregates.map(a => `${a.function}(${a.column ?? 'rows'}) → ${a.as}`).join('; ')}` : `按 ${step.by.join('、') || '所有行'} 分组；${step.aggregates.map(a => `${a.column ?? '行数'} ${a.function === 'sum' ? '求和' : a.function === 'avg' ? '平均' : a.function === 'count' ? '计数' : a.function === 'min' ? '最小值' : '最大值'} → ${a.as}`).join('；')}`;
  case 'yoy': return en ? `Year-over-year for ${step.valueColumn}, by ${step.yearColumn}` : `计算 ${step.valueColumn} 的同比，年份列为 ${step.yearColumn}`;
  case 'select': return en ? `Keep columns: ${step.columns.join(', ')}` : `保留列：${step.columns.join('、')}`;
 }
}
