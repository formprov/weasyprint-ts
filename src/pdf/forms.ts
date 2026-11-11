// SPDX-License-Identifier: BSD-3-Clause

/** PDF form widgets (mirrors weasyprint/pdf/anchors.py add_forms and _get_human_name). */
import type { Element } from '../dom.ts';
import type { Matrix } from '../matrix.ts';
import type { PdfStream } from './stream.ts';
import { Dictionary, PDF, PdfArray, PdfString } from './pydyf.ts';

type AnyBox = any;

function* descendantsOf(element: Element): Generator<Element> {
  for (const child of element.children) {
    yield child;
    yield* descendantsOf(child);
  }
}

function getHumanName(form: AnyBox | null, element: Element, inputName: string): string {
  if (form) {
    const inputId = element.get('id');
    for (const label of descendantsOf(form.element as Element)) {
      if (label.tag !== 'label') continue;
      const forMatch = inputId && inputId === label.get('for');
      let isChild = false;
      for (const d of descendantsOf(label)) if (d === element && d.tag === 'input') isChild = true;
      if (forMatch || isChild) {
        // Find the label's box to get its whitespace-processed text.
        for (const box of form.descendants?.() ?? []) {
          if (box.element === label) return box.contentText;
        }
        let text = label.text ?? '';
        text += label.children.map((child) => child.tail ?? '').join('');
        return text.trim();
      }
    }
  }
  const title = element.get('title');
  if (title) return title;
  const placeholder = element.get('placeholder');
  if (placeholder) return placeholder;
  return element.get('name', '') ?? '';
}

/** Include form inputs in PDF. */
export function addForms(forms: Map<AnyBox, Array<[AnyBox, number[]]>>, matrix: Matrix, pdf: PDF, page: Dictionary,
  resources: Dictionary, stream: PdfStream): void {
  if (!forms || ![...forms.values()].some((inputs) => inputs.length)) return;

  if (!page.has('Annots')) page.set('Annots', new PdfArray());
  if (!pdf.catalog.has('AcroForm')) {
    pdf.catalog.set('AcroForm', new Dictionary({
      Fields: new PdfArray(), DR: resources.reference, NeedAppearances: 'true',
    }));
  }
  const acroForm = pdf.catalog.get('AcroForm') as Dictionary;
  const pageReference = String(page.get('Contents')).split(' ')[0];
  const inputsWithForms: Array<[AnyBox, AnyBox, number[]]> = [];
  for (const [form, inputs] of forms) for (const [box, rectangle] of inputs) inputsWithForms.push([form, box, rectangle]);
  const radioGroups = new Map<AnyBox, Map<string, Dictionary>>();
  const fieldsByForm = new Map<AnyBox, Map<string, Dictionary>>();

  inputsWithForms.forEach(([form, box, rect], i) => {
    const element: Element = box.element;
    const style = box.style;
    const [x1, y1] = matrix.transformPoint(rect[0], rect[1]);
    const [x2, y2] = matrix.transformPoint(rect[2], rect[3]);
    const rectangle = [x1, y1, x2, y2];

    const inputType = element.get('type');
    const inputValue = element.get('value', 'Yes') as string;
    const inputName = element.get('name', `unknown-${pageReference}-${i}`) as string;
    const inputHumanName = getHumanName(form, element, inputName);
    // Set smaller font size to align the text within the box.
    const fontSize = style.get('font_size') * 0.75;
    const fieldStream = stream.clone();
    fieldStream.setColor(style.get('color'));
    const field = new Dictionary({
      Type: '/Annot', Subtype: '/Widget', Rect: new PdfArray(rectangle), P: page.reference,
      F: 1 << (3 - 1), // Print flag
      T: new PdfString(inputName), TU: new PdfString(inputHumanName),
    });
    const addFieldFont = (): any => {
      const faces = style.fontConfig.match(style.get('font_family'), style.get('font_weight'), style.get('font_style'), style.get('font_stretch'));
      const font = stream.addFont(faces[0], fontSize, style);
      font.usedInForms = true;
      fieldStream.setFontSize(font.hash, fontSize);
      return font;
    };
    const daString = (): PdfString => new PdfString(fieldStream.stream.map((item: any) => (typeof item === 'string' ? item : String.fromCharCode(...(item as Uint8Array)))).join(' '));

    let group: Dictionary | undefined;
    if (inputType === 'radio' || inputType === 'checkbox') {
      // Create stream when input is checked.
      const width = rectangle[2] - rectangle[0];
      const height = rectangle[1] - rectangle[3];
      const cx = width / 2, cy = height / 2, rx = width / 2, ry = height / 2;
      const checkedStream = stream.clone({
        resources: undefined,
        extra: new Dictionary({
          Resources: resources.reference, Type: '/XObject', Subtype: '/Form', BBox: new PdfArray([0, 0, width, height]),
        }),
      });
      checkedStream.setColor(style.get('color'));
      if (inputType === 'radio') {
        if (!radioGroups.has(form)) radioGroups.set(form, new Map());
        const groups = radioGroups.get(form)!;
        if (!groups.has(inputName)) {
          const g = new Dictionary({
            FT: '/Btn', Ff: (1 << (15 - 1)) + (1 << (16 - 1)), // NoToggle & Radio
            T: new PdfString(inputName), TU: new PdfString(inputHumanName), V: '/Off', Kids: new PdfArray(), Opt: new PdfArray(),
          });
          groups.set(inputName, g);
          pdf.addObject(g);
          (acroForm.get('Fields') as PdfArray).push(g.reference);
        }
        group = groups.get(inputName)!;
        const px = rx / Math.sqrt(Math.PI), py = ry / Math.sqrt(Math.PI);
        checkedStream.moveTo(cx + rx, cy);
        checkedStream.curveTo(cx + rx, cy + py, cx + px, cy + ry, cx, cy + ry);
        checkedStream.curveTo(cx - px, cy + ry, cx - rx, cy + py, cx - rx, cy);
        checkedStream.curveTo(cx - rx, cy - py, cx - px, cy - ry, cx, cy - ry);
        checkedStream.curveTo(cx + px, cy - ry, cx + rx, cy - py, cx + rx, cy);
      } else {
        checkedStream.moveTo(cx - rx, cy);
        checkedStream.lineTo(cx, cy - ry);
        checkedStream.lineTo(cx + rx, cy + ry);
        checkedStream.lineTo(cx - rx / 7, cy - ry / 3);
      }
      checkedStream.close();
      checkedStream.fill();
      pdf.addObject(checkedStream);

      const color = style.get('color').coordinates ?? [style.get('color').r, style.get('color').g, style.get('color').b];
      const checked = element.attrs.has('checked');
      const key = inputType === 'radio' ? String((group!.get('Kids') as PdfArray).items.length) : 'on';
      field.set('FT', '/Btn');
      field.set('AS', checked ? `/${key}` : '/Off');
      field.set('AP', new Dictionary({ N: new Dictionary({ [key]: checkedStream.reference }) }));
      field.set('MK', new Dictionary({ BC: new PdfArray(color as number[]) }));
      field.set('Border', new PdfArray([0, 0, 0]));
      pdf.addObject(field);
      if (inputType === 'radio') {
        field.set('Parent', group!.reference);
        if (checked) group!.set('V', `/${key}`);
        (group!.get('Kids') as PdfArray).push(field.reference);
        (group!.get('Opt') as PdfArray).push(new PdfString(inputValue));
      } else {
        field.set('T', new PdfString(inputName));
        field.set('TU', new PdfString(inputHumanName));
        field.set('V', field.get('AS') as string);
      }
    } else if (element.tag === 'select') {
      addFieldFont();
      const options: PdfArray[] = [];
      const selectedValues: PdfString[] = [];
      for (const option of element.elementChildren) {
        const value = new PdfString(option.get('value', '') as string);
        options.push(new PdfArray([value, new PdfString(option.text ?? '')]));
        if (option.attrs.has('selected')) selectedValues.push(value);
      }
      field.set('FT', '/Ch');
      field.set('DA', daString());
      field.set('Opt', new PdfArray(options));
      if (element.attrs.has('multiple')) {
        field.set('Ff', 1 << (22 - 1));
        field.set('V', new PdfArray(selectedValues));
      } else {
        field.set('Ff', 1 << (18 - 1));
        field.set('V', selectedValues.length ? selectedValues[selectedValues.length - 1] : new PdfString(''));
      }
      pdf.addObject(field);
    } else if (inputType === 'submit' || element.tag === 'button') {
      const formElement: Element | undefined = form?.element;
      const action = formElement?.get('action');
      if (action) {
        let flags = 1 << (3 - 1); // HTML form format
        // Upstream builds the push-button only for GET forms (POST submit buttons get no action).
        if ((formElement!.get('method', '') ?? '').toLowerCase() !== 'post') {
          flags += 1 << (4 - 1); // GET method
          const fields = new PdfArray();
          for (const f of fieldsByForm.get(form)?.values() ?? []) fields.push(f.reference);
          field.set('FT', '/Btn');
          field.set('DA', daString());
          field.set('V', new PdfString(formElement!.get('value', '') as string));
          field.set('Ff', 1 << (17 - 1)); // Push-button
          field.set('A', new Dictionary({ Type: '/Action', S: '/SubmitForm', F: new PdfString(action), Fields: fields, Flags: flags }));
        }
      }
      pdf.addObject(field);
    } else {
      // Text, password, textarea, files, and other unknown fields.
      addFieldFont();
      field.set('FT', '/Tx');
      field.set('DA', daString());
      field.set('V', new PdfString(element.get('value', '') as string));
      if (element.tag === 'textarea') {
        field.set('Ff', 1 << (13 - 1));
        field.set('V', new PdfString(element.text ?? ''));
      } else if (inputType === 'password') field.set('Ff', 1 << (14 - 1));
      else if (inputType === 'file') field.set('Ff', 1 << (21 - 1));
      const maxLength = element.get('maxlength', '') ?? '';
      if (/^\d+$/.test(maxLength)) field.set('MaxLen', maxLength);
      pdf.addObject(field);
    }

    box.widgetAnnotation = field;
    (page.get('Annots') as PdfArray).push(field.reference);
    (acroForm.get('Fields') as PdfArray).push(field.reference);
    if (!fieldsByForm.has(form)) fieldsByForm.set(form, new Map());
    const byName = fieldsByForm.get(form)!;
    if (!byName.has(inputName)) byName.set(inputName, field);
  });
}
