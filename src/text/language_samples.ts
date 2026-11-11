// SPDX-License-Identifier: LGPL-2.1-or-later
// BSD-3-Clause for the port of the used logic.

/**
 * Pango's language sample strings (pango-language-sample-table.h) — used only
 * for `approximate_char_width`, the advance Pango gives unknown-glyph code
 * points. The table is abbreviated to the languages that realistically appear
 * in parity corpora; unknown languages fall back to the classic pangram, as
 * pango does.
 */
const SAMPLES: Record<string, string> = {
  af: 'Ek kan glas eet, maar dit doen my nie skade nie.',
  ar: 'نص حكيم له سر قاطع وذو شأن عظيم مكتوب على ثوب أخضر ومغلف بجلد أزرق.',
  arn: 'Gvxam mincetu apocikvyeh: ñizol ce mamvj ka raq kuse bafkeh mew.',
  bg: 'Под южно дърво, цъфтящо в синьо, бягаше малко пухкаво зайче.',
  cs: 'Příliš žluťoučký kůň úpěl ďábelské ódy.',
  da: 'Quizdeltagerne spiste jordbær med fløde, mens cirkusklovnen Walther spillede på xylofon.',
  de: 'Zwölf Boxkämpfer jagen Viktor quer über den großen Sylter Deich.',
  el: 'Θέλει αρετή και τόλμη η ελευθερία. (Ανδρέας Κάλβος)',
  en: 'The wizard quickly jinxed the gnomes before they vaporized.',
  eo: 'Eĥoŝanĝo ĉiuĵaŭde.',
  es: 'Jovencillo emponzoñado de whisky: ¡qué figurota exhibe!',
  et: 'See väike mölder jõuab rongile hüpata.',
  fa: '«الا یا اَیُّها السَّاقی اَدِرْ کَاساً وَ ناوِلْها!» که عشق آسان نمود اوّل، ولی افتاد مشکل‌ها!',
  fi: 'Viekas kettu punaturkki laiskan koiran takaa kurkki.',
  fr: "Voix ambiguë d'un cœur qui, au zéphyr, préfère les jattes de kiwis.",
  ga: 'Chuaigh bé mhórshách le dlúthspád fíorfhinn trí hata mo dhea-phorcáin bhig.',
  he: 'דג סקרן שט לו בים זך אך לפתע פגש חבורה נחמדה שצצה כך.',
  hi: 'नहीं नजर किसी की बुरी नहीं किसी का मुँह काला जो करे सो उपर वाला',
  hu: "Egy hűtlen vejét fülöncsípő, dühős mexikói úr Wesselényinél mázol Quitóban.",
  is: 'Kæmi ný öxi hér ykist þjófum nú bæði víl og ádrepa',
  it: 'Ma la volpe, col suo balzo, ha raggiunto il quieto Fido.',
  ja: 'いろはにほへと ちりぬるを 色は匂へど 散りぬるを',
  lv: 'Sarkanās jūrascūciņas peld pa jūru.',
  mk: 'Можам да јадам стакло, а не ме штета.',
  nb: 'Vår sære Zulu fra badeøya spilte jo whist og quickstep i min taxi.',
  nl: "Pa's wijze lynx bezag vroom het fikse aquaduct.",
  pl: 'Pchnąć w tę łódź jeża lub ośm skrzyń fig.',
  pt: 'Vejam a bruxa da raposa Salta-Pocinhas e o cão feliz que dorme regalado.',
  ru: 'В чащах юга жил бы цитрус? Да, но фальшивый экземпляр!',
  sl: 'Šerif bo za vajo spet kuhal domače žgance.',
  sv: 'Flygande bäckasiner söka strax hwila på mjuka tuvor.',
  th: 'เป็นมนุษย์สุดประเสริฐเลิศคุณค่า - กว่าบรรดาฝูงสัตว์เดรัจฉาน - จงฝ่าฟันพัฒนาวิชาการ อย่าล้างผลาญฤๅเข่นฆ่าบีฑาใคร - ไม่ถือโทษโกรธแช่งซัดฮึดฮัดด่า - หัดอภัยเหมือนกีฬาอัชฌาสัย - ปฏิบัติประพฤติกฎกำหนดใจ - พูดจาให้จ๊ะ ๆ จ๋า ๆ น่าฟังเอยฯ',
  tr: 'Pijamalı hasta yağız şoföre çabucak güvendi.',
  uk: 'Чуєш їх, доцю, га? Кумедна ж ти, прощайся без ґольфів!',
  vi: 'Con sói nâu nhảy qua con chó lười.',
  'zh-cn': '我能吞下玻璃而不伤身体。',
  'zh-mo': '我能吞下玻璃而不傷身體。',
  'zh-sg': '我能吞下玻璃而不伤身体。',
  'zh-tw': '我能吞下玻璃而不傷身體。',
};

/** The fallback for languages without an entry (pango_language_get_sample_string). */
export const FOX_PANGRAM = 'The quick brown fox jumps over the lazy dog.';

/** Pango's best-match sample string for `lang` (best-prefix matching, then the fallback). */
export function sampleStringFor(lang: string | null): string {
  if (lang) {
    for (let tag = lang.toLowerCase().replace(/_/g, '-'); tag;) {
      const hit = SAMPLES[tag];
      if (hit) return hit;
      const cut = tag.lastIndexOf('-');
      if (cut === -1) break;
      tag = tag.slice(0, cut);
    }
  }
  return FOX_PANGRAM;
}

/** pango_utf8_strwidth: wide code points count 2, zero-width count 0, others 1. */
export function utf8Strwidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (/(?:\p{M}|\p{Cf})/u.test(ch)) continue; // combining marks and format controls count 0
    if (isEastAsianWide(cp)) width += 2;
    else width += 1;
  }
  return width;
}

/** East Asian Width W and F ranges (Unicode 16). */
function isEastAsianWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd);
}
