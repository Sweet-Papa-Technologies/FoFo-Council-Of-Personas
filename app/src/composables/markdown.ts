// Minimal, dependency-free markdown → HTML for the Chairman's synthesis.
// Escapes HTML FIRST (so model output can never inject markup), then applies a
// small, safe subset: headings, bold/italic, inline code, and bullet lists.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split('\n');
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);

    if (heading) {
      closeList();
      const level = Math.min((heading[1] ?? '').length + 2, 6); // # -> h3
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
    } else if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1] ?? '')}</li>`);
    } else if (numbered) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(numbered[1] ?? '')}</li>`);
    } else if (line === '') {
      closeList();
      out.push('');
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}
