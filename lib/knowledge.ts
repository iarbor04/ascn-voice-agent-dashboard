export type KnowledgeFile = { id: string; name: string; text: string };

// Служебные слова совпадают почти в любом абзаце и дают ложные ответы:
// запрос «можно вернуть, если не подошли» без них перестаёт цеплять доставку.
const stopWords = new Set([
  "или", "если", "как", "что", "это", "там", "тут", "нет", "два", "мне", "вам", "нам", "они", "она", "оно",
  "можно", "нужно", "надо", "есть", "быть", "будет", "было", "хочу", "хотел", "хотела", "скажите", "подскажите",
  "пожалуйста", "здравствуйте", "спасибо", "ваш", "ваша", "ваши", "вашего", "меня", "тебя", "себя", "когда",
  "почему", "зачем", "какой", "какая", "какие", "сколько", "где", "куда", "тогда", "потом", "ещё", "еще", "уже",
]);

// Абзац — минимальная единица ответа: агент читает найденное вслух,
// поэтому куски должны быть законченными, а не обрезанными по символам.
function paragraphs(text: string) {
  return text.split(/\n\s*\n|\r\n\s*\r\n/).map((block) => block.trim().replace(/\s+/g, " ")).filter((block) => block.length > 2);
}

// Русские окончания ломают точное сравнение: «доставки» и «доставка» — одно слово.
// Сравниваем по началу, оставляя короткие слова как есть.
function stem(word: string) {
  return word.length > 5 ? word.slice(0, word.length - 2) : word;
}

// Клиент говорит «нью бэланс», а в файле написано «New Balance». Обратные замены
// произношения — готовый мост между тем, как звучит, и тем, как написано.
function expand(query: string, aliases: Array<{ from: string; to: string }>) {
  let expanded = query.toLowerCase();
  for (const alias of aliases) {
    if (!alias.from || !alias.to) continue;
    if (expanded.includes(alias.to.toLowerCase())) expanded += ` ${alias.from.toLowerCase()}`;
  }
  return expanded;
}

function terms(query: string) {
  const words = query.split(/[^a-zа-яё0-9]+/i).filter((word) => word.length >= 3 && !stopWords.has(word));
  return [...new Set(words.map(stem))];
}

export function searchKnowledge(files: KnowledgeFile[], query: string, limit = 5, aliases: Array<{ from: string; to: string }> = []) {
  const words = terms(expand(query, aliases));
  if (!words.length) return [];
  const scored: Array<{ file: string; text: string; score: number }> = [];
  for (const file of files) {
    const title = file.name.toLowerCase();
    for (const block of paragraphs(file.text)) {
      const lower = block.toLowerCase();
      const hits = words.filter((word) => lower.includes(word));
      const titleHits = words.filter((word) => !lower.includes(word) && title.includes(word));
      if (!hits.length && !titleHits.length) continue;
      // Совпавшие слова важнее длины: короткий точный абзац лучше длинного с одним словом.
      // Попадание в имя файла считается за половину — оно указывает на тему, а не на ответ.
      const score = hits.length * 100 + titleHits.length * 50 - Math.min(99, Math.floor(block.length / 40));
      scored.push({ file: file.name, text: block.slice(0, 1200), score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ file, text }) => ({ file, text }));
}
