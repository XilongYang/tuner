// 语言检测：区分日语（ja）和英语（en）。
// 策略：只要句子里出现假名（平假名/片假名）或日文汉字，就判为日语；
// 否则判为英语。对纯汉字（也可能是中文）的情况，此工具场景默认按日语处理，
// 用户可在界面手动切换覆盖。

// 平假名 3040–309F、片假名 30A0–30FF、CJK 汉字 4E00–9FFF、
// 半角片假名 FF66–FF9F、日文标点等。
const JA_KANA = /[぀-ヿｦ-ﾟ]/;
const CJK = /[㐀-䶿一-鿿]/;

export const LOCALES = {
  ja: 'ja-JP',
  en: 'en-US',
};

/**
 * 检测单句语言。
 * @param {string} sentence
 * @returns {'ja' | 'en'}
 */
export function detectLang(sentence) {
  if (!sentence) return 'en';
  // 有假名 → 一定是日语
  if (JA_KANA.test(sentence)) return 'ja';
  // 无假名但有汉字 → 该场景下按日语处理（用户可手动改）
  if (CJK.test(sentence)) return 'ja';
  return 'en';
}
