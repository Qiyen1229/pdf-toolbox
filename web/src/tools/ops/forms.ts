import {
  PDFDocument, PDFName, PDFString, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton, PDFSignature,
  PDFFont, StandardFonts, rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadPdf, savePdf, toUser, visibleFrame } from './pdf';

export interface FormFieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'button' | 'signature' | 'unknown';
  value: string | boolean | string[];
  options?: string[];
  multiline?: boolean;
  readOnly: boolean;
}

export async function listFormFields(bytes: Uint8Array): Promise<FormFieldInfo[]> {
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  return form.getFields().map((f): FormFieldInfo => {
    const base = { name: f.getName(), readOnly: f.isReadOnly() };
    if (f instanceof PDFTextField) return { ...base, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline() };
    if (f instanceof PDFCheckBox) return { ...base, type: 'checkbox', value: f.isChecked() };
    if (f instanceof PDFRadioGroup) return { ...base, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions() };
    if (f instanceof PDFDropdown) return { ...base, type: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions() };
    if (f instanceof PDFOptionList) return { ...base, type: 'list', value: f.getSelected(), options: f.getOptions() };
    if (f instanceof PDFButton) return { ...base, type: 'button', value: '' };
    if (f instanceof PDFSignature) return { ...base, type: 'signature', value: '' };
    return { ...base, type: 'unknown', value: '' };
  });
}

async function cjkFont(doc: PDFDocument, fontBytes?: Uint8Array): Promise<PDFFont | null> {
  if (fontBytes) { doc.registerFontkit(fontkit); return doc.embedFont(fontBytes, { subset: true }); }
  return null;
}

export async function fillForm(bytes: Uint8Array, values: Record<string, string | boolean | string[]>, opt: { flatten?: boolean; fontBytes?: Uint8Array } = {}): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const font = await cjkFont(doc, opt.fontBytes);

  // 檢查是否有包含中文等非 ASCII 字元
  const hasCjk = Object.values(values).some((v) =>
    typeof v === 'string' ? /[^\x00-\x7F]/.test(v) : Array.isArray(v) ? v.some((s) => /[^\x00-\x7F]/.test(String(s))) : false
  );

  for (const [name, v] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    if (f instanceof PDFTextField) f.setText(String(v));
    else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck());
    else if (f instanceof PDFRadioGroup) { if (v) f.select(String(v)); }
    else if (f instanceof PDFDropdown) { if (v) f.select(String(v)); }
    else if (f instanceof PDFOptionList) f.select(Array.isArray(v) ? v : [String(v)]);
  }

  // 啟用 PDF 規範的 NeedAppearances，使閱讀器開啟時調用本機 CJK 字型動態渲染表單
  const acroForm = doc.catalog.getOrCreateAcroForm();
  acroForm.dict.set(PDFName.of('NeedAppearances'), doc.context.obj(true));

  let appearanceUpdated = false;
  if (font) {
    try {
      form.updateFieldAppearances(font);
      appearanceUpdated = true;
    } catch {
      // 若字型缺字，自動由 NeedAppearances 備援
    }
  } else if (!hasCjk) {
    try {
      const helvetica = await doc.embedFont(StandardFonts.Helvetica);
      form.updateFieldAppearances(helvetica);
      appearanceUpdated = true;
    } catch {
      // 容錯
    }
  }

  if (opt.flatten) {
    if (hasCjk && !font) {
      throw new Error('「扁平化」會將文字永久固定於頁面中，包含中文時需要嵌入字型檔（.ttf/.otf）。若不勾選「扁平化」，可直接輸出並使用所有主流 PDF 閱讀器正常顯示與列印中文。');
    }
    form.flatten({ updateFieldAppearances: appearanceUpdated });
  }

  return savePdf(doc, { updateFieldAppearances: appearanceUpdated });
}

export async function flattenForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  doc.getForm().flatten();
  return savePdf(doc);
}

export interface NewField {
  kind: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'date' | 'multiline';
  name: string;
  page: number;           // 0-based
  x: number; y: number; w: number; h: number; // 視覺座標，左上原點，pt
  options?: string[];     // radio / dropdown
  value?: string;
  required?: boolean;
}
export async function createFormFields(bytes: Uint8Array, fields: NewField[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const form = doc.getForm();
  const pages = doc.getPages();
  const names = new Set(form.getFields().map((f) => f.getName()));
  for (const f of fields) {
    if (!f.name.trim()) throw new Error('每個欄位都需要名稱');
    if (names.has(f.name) && f.kind !== 'radio') throw new Error(`欄位名稱重複：${f.name}`);
    const page = pages[f.page];
    const fr = visibleFrame(page);
    // 視覺左上原點矩形 → 使用者空間左下 + 寬高
    const a = toUser(page, f.x, fr.h - f.y - f.h, 0), b = toUser(page, f.x + f.w, fr.h - f.y, 0);
    const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    const style = { borderColor: rgb(0.3, 0.3, 0.8), borderWidth: 1, backgroundColor: rgb(0.95, 0.96, 1) };
    names.add(f.name);
    if (f.kind === 'text' || f.kind === 'date' || f.kind === 'multiline') {
      const tf = form.createTextField(f.name);
      if (f.kind === 'multiline') tf.enableMultiline();
      if (f.value) tf.setText(f.value);
      if (f.required) tf.enableRequired();
      tf.addToPage(page, { ...box, ...style });
      if (f.kind === 'date') {
        const mk = (js: string) => doc.context.obj({ S: 'JavaScript', JS: PDFString.of(js) });
        tf.acroField.dict.set(PDFName.of('AA'), doc.context.obj({ F: mk('AFDate_FormatEx("yyyy-mm-dd");'), K: mk('AFDate_KeystrokeEx("yyyy-mm-dd");') }));
      }
    } else if (f.kind === 'checkbox') {
      const cb = form.createCheckBox(f.name);
      if (f.required) cb.enableRequired();
      cb.addToPage(page, { ...box, ...style });
    } else if (f.kind === 'radio') {
      const opts = f.options?.length ? f.options : ['選項'];
      const rg = form.getFieldMaybe(f.name) instanceof PDFRadioGroup ? (form.getRadioGroup(f.name)) : form.createRadioGroup(f.name);
      for (const o of opts) rg.addOptionToPage(o, page, { ...box, ...style });
    } else if (f.kind === 'dropdown') {
      const dd = form.createDropdown(f.name);
      dd.addOptions(f.options?.length ? f.options : ['選項 1', '選項 2']);
      if (f.required) dd.enableRequired();
      dd.addToPage(page, { ...box, ...style });
    }
  }
  return savePdf(doc);
}
