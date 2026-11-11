// SPDX-License-Identifier: BSD-3-Clause

/**
 * PDF metadata stream (mirrors weasyprint/pdf/metadata.py): the XMP packet of PDF/A, PDF/X and PDF/UA documents and
 * of plain documents with metadata. The RDF is built as upstream's generate_rdf_metadata does, element by element.
 */
import type { HtmlMetadata } from '../html.ts';
import { Dictionary, PDF, Stream } from './pydyf.ts';

export const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  xmpMM: 'http://ns.adobe.com/xap/1.0/mm/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  pdfaid: 'http://www.aiim.org/pdfa/ns/id/',
  pdfuaid: 'http://www.aiim.org/pdfua/ns/id/',
  pdfxid: 'http://www.npes.org/pdfx/ns/id/',
  pdfx: 'http://ns.adobe.com/pdfx/1.3/',
} as const;

type Prefix = keyof typeof NS | 'xml';

interface XmlNode {
  prefix: Prefix;
  local: string;
  attrs: Array<[Prefix, string, string]>;
  children: XmlNode[];
  text?: string;
}

function el(prefix: Prefix, local: string, children: XmlNode[] = [], text?: string): XmlNode {
  return { prefix, local, attrs: [], children, text };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Serialize with the namespaces used declared on the root, as ElementTree does. */
function serialize(root: XmlNode): string {
  const used = new Map<string, Prefix>();
  const visit = (node: XmlNode): void => {
    used.set(node.prefix, node.prefix);
    for (const [p] of node.attrs) used.set(p, p);
    node.children.forEach(visit);
  };
  visit(root);
  const decls = [...used.keys()].filter((p) => p !== 'xml').sort()
    .map((p) => ` xmlns:${p}="${NS[p as keyof typeof NS]}"`).join('');
  const render = (node: XmlNode): string => {
    const attrs = node.attrs.map(([p, n, v]) => ` ${p === 'xml' ? 'xml' : p}:${n}="${escapeXml(v)}"`).join('');
    const inner = node.text !== undefined ? escapeXml(node.text) : node.children.map(render).join('');
    if (node.text === undefined && node.children.length === 0) return `<${node.prefix}:${node.local}${attrs} />`;
    return `<${node.prefix}:${node.local}${attrs}>${inner}</${node.prefix}:${node.local}>`;
  };
  return render(root).replace(`<${root.prefix}:${root.local}`, `<${root.prefix}:${root.local}${decls}`);
}

/** WeasyPrint's version, as written to the Producer (Python: weasyprint.__version__). */
const VERSION = '70.0';

/** Generate a fresh identifier for PDF/X-4 (upstream: uuid4()). */
function uuid(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Python: DocumentMetadata.generate_rdf_metadata(variant, version, conformance). */
export function generateRdfMetadata(meta: HtmlMetadata, variant: string, version: number | null,
  conformance: string | null): string {
  const namespace = `pdf${variant}id` as Prefix;
  const about = (node: XmlNode): XmlNode => {
    node.attrs.push(['rdf', 'about', '']);
    return node;
  };
  const description = (...children: XmlNode[]): XmlNode => about(el('rdf', 'Description', children));
  const rdf = el('rdf', 'RDF');

  let versionElement: XmlNode | null = null;
  if (version) {
    const element = about(el('rdf', 'Description'));
    versionElement = element;
    if (!(variant === 'x' && version >= 4)) element.attrs.push([namespace, 'part', String(version)]);
    rdf.children.push(element);
  }
  if (conformance) {
    if (variant === 'x') {
      const element = versionElement!;
      element.children.push(el('pdfxid', 'GTS_PDFXVersion', [], conformance));
      element.children.push(el('pdfx', 'GTS_PDFXVersion', [], conformance));
      element.children.push(el('pdfx', 'GTS_PDFXConformance', [], conformance));
      element.children.push(el('pdf', 'Trapped', [], 'False'));
      if ((version ?? 0) >= 4) {
        // Upstream: these values could be useful instead of random values.
        if (!meta.modified) throw new Error('PDF/X-4 needs a modification date');
        element.children.push(el('xmp', 'MetadataDate', [], meta.modified));
        element.children.push(el('xmpMM', 'DocumentID', [], `xmp.did:${uuid()}`));
        element.children.push(el('xmpMM', 'RenditionClass', [], 'proof:pdf'));
        element.children.push(el('xmpMM', 'VersionID', [], '1'));
      }
    } else {
      if (!version) throw new Error('a conformance needs a version');
      // Upstream sets the conformance on the element that already carries the part number.
      const element = versionElement!;
      element.attrs.push([namespace, 'conformance', conformance]);
      if (variant === 'a' && version === 4) element.children.push(el('pdfaid', 'rev', [], '2020'));
      else if (variant === 'ua' && version === 2) element.children.push(el('pdfuaid', 'rev', [], '2024'));
    }
  }

  const producer = about(el('rdf', 'Description'));
  producer.attrs.push(['pdf', 'Producer', `WeasyPrint ${VERSION}`]);
  rdf.children.push(producer);

  if (meta.title) {
    rdf.children.push(description(el('dc', 'title', [el('rdf', 'Alt', [liDefault(meta.title)])])));
  }
  if (meta.authors.length) {
    rdf.children.push(description(el('dc', 'creator', [el('rdf', 'Seq', meta.authors.map((a) => el('rdf', 'li', [], a)))])));
  }
  if (meta.description) {
    rdf.children.push(description(el('dc', 'description', [el('rdf', 'Alt', [liDefault(meta.description)])])));
  }
  if (meta.keywords.length) {
    rdf.children.push(description(el('pdf', 'Keywords', [], meta.keywords.join(', '))));
  }
  if (meta.generator) {
    rdf.children.push(description(el('xmp', 'CreatorTool', [], meta.generator)));
  }
  if (meta.created) {
    rdf.children.push(description(el('xmp', 'CreateDate', [], meta.created)));
  }
  if (meta.modified) {
    rdf.children.push(description(el('xmp', 'ModifyDate', [], meta.modified)));
  }
  return serialize(rdf);
}

function liDefault(text: string): XmlNode {
  const li = el('rdf', 'li', [], text);
  li.attrs.push(['xml', 'lang', 'x-default']);
  return li;
}

/**
 * Python: DocumentMetadata.include_in_pdf. The XMP packet becomes the catalog's /Metadata stream.
 * `conformance` is the variant letter for PDF/A ('B', 'U', ...), the conformance string for PDF/X and PDF/UA.
 */
export function includeMetadataInPdf(pdf: PDF, meta: HtmlMetadata, variant: string, version: number | null,
  conformance: string | null, compress: boolean): void {
  const header = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/">';
  const footer = '</x:xmpmeta>\n<?xpacket end="r"?>';
  const xml = generateRdfMetadata(meta, variant, version, conformance);
  const content = [header, xml, ...(meta.xmpMetadata ?? []), footer].join('\n');
  const extra = new Dictionary({ Type: '/Metadata', Subtype: '/XML' });
  const metadata = new Stream([content], extra, compress);
  pdf.addObject(metadata);
  pdf.catalog.set('Metadata', metadata.reference);
}
