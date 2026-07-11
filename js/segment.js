// 句子拆分：按日语（。！？）和英语（.!?）的句末标点分句，保留标点。
// 设计目标：对混合文本足够健壮，同时保持逻辑简单、可审计。

// 句末标点：中日全角 。！？…；英文半角 . ! ?
// 注意：英文句点会误伤缩写（如 Mr. / U.S.），此处做最小化处理，
// 后续如有需要再引入更复杂的缩写词典。
const TERMINATORS = /([。．！？!?…]+|\.(?=\s|$))/g;

/**
 * 将一段文本拆分为句子数组。
 * - 保留句末标点
 * - 按换行也做一次切分（换行视为硬分隔）
 * - 去除首尾空白，过滤空句
 * @param {string} text
 * @returns {string[]}
 */
export function segment(text) {
  if (!text) return [];

  const sentences = [];

  // 先按换行拆成段落，段落内再按句末标点拆句。
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    let buffer = '';
    let lastIndex = 0;
    let match;

    TERMINATORS.lastIndex = 0;
    while ((match = TERMINATORS.exec(trimmedLine)) !== null) {
      const end = match.index + match[0].length;
      buffer = trimmedLine.slice(lastIndex, end);
      const cleaned = buffer.trim();
      if (cleaned) sentences.push(cleaned);
      lastIndex = end;
    }

    // 段落末尾没有标点的残余部分也作为一句。
    const tail = trimmedLine.slice(lastIndex).trim();
    if (tail) sentences.push(tail);
  }

  return sentences;
}
