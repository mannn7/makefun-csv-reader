// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01): run(input) returns
// exactly csv-reader's {columns, rows, errors} for {text, header}, but reads the text with
// two sticky regex scans (one for the next separator of an unquoted field, one for the next
// quote or line break inside a quoted field) and slices each field out whole instead of
// building it one character at a time.
//
// The semantics follow the reference (vendor/csv-reader/index.js in the kit) exactly:
// a U+FEFF at the start is dropped; a record ends at LF or CRLF and an empty line is no
// record; outside quotes a CR not followed by LF is dropped (stray_cr); a field that opens
// with a quote runs to the next quote that is not doubled ("" inside it is one quote, each
// CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the next
// comma or line break, is appended as it stands (quote_junk, when the field ends); a quote
// that never closes is a literal character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal character; fields
// stay strings, never trimmed or converted; columns is the first record when header is
// true, else null; rows are padded with "" (short_row, with fields: its count) or cut
// (long_row, with extra: the cut fields) to the first record's width; each error is
// {code, line, row} in the order met, line the 1-based line its record starts on and row
// its record's index in rows, null for the header.

const COMMA = 0;
const LB = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recLine = 1;
  let recRow = null;
  // The field just read: its value, how it ended and how many characters were kept.
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  // Reads an unquoted field from pos, appending to `val` ('' for a fresh field, '"' for the
  // re-read after an unterminated quote, a quoted value for the junk after a closing quote).
  // Sets fVal/fEnd/fAdded; a stray CR pushes its error and is dropped, not counted.
  // One sticky regex scan finds the next separator instead of three indexOf calls.
  const SEP = /[,\r\n]/g;
  function unquoted(val) {
    let added = 0;
    SEP.lastIndex = pos;
    let m;
    while ((m = SEP.exec(text)) !== null) {
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        if (added === 0 && val === '') val = text.slice(pos, i);
        else val += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        fVal = val;
        fEnd = COMMA;
        fAdded = added;
        return;
      }
      if (c === '\n') {
        if (added === 0 && val === '') val = text.slice(pos, i);
        else val += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        line += 1;
        fVal = val;
        fEnd = LB;
        fAdded = added;
        return;
      }
      // A CR: a CRLF ends the field, a lone CR is dropped with its error and the field goes on.
      if (added === 0 && val === '') val = text.slice(pos, i);
      else val += text.slice(pos, i);
      added += i - pos;
      if (text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        fVal = val;
        fEnd = LB;
        fAdded = added;
        return;
      }
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      pos = i + 1;
      SEP.lastIndex = pos;
    }
    if (added === 0 && val === '') val = text.slice(pos);
    else val += text.slice(pos);
    added += n - pos;
    pos = n;
    fVal = val;
    fEnd = END;
    fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnd (fAdded is 0, except
  // the junk after its closing quote, which unquoted() counts). One sticky regex scan
  // finds the next quote or line break inside it, so a segment with no line break costs
  // a single scan and a slice.
  const QSEP = /["\r\n]/g;
  function quoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let val = '';
    let closed = false;
    QSEP.lastIndex = pos;
    let m;
    while ((m = QSEP.exec(text)) !== null) {
      const i = m.index;
      const c = m[0];
      if (c === '"') {
        if (val === '') val = text.slice(pos, i);
        else val += text.slice(pos, i);
        if (text.charCodeAt(i + 1) === 34) {
          val += '"';
          pos = i + 2;
          QSEP.lastIndex = pos;
          continue;
        }
        pos = i + 1;
        closed = true;
        break;
      }
      // A line break inside quotes is one LF in the value; a CRLF counts once.
      if (val === '') val = text.slice(pos, i);
      else val += text.slice(pos, i);
      val += '\n';
      line += 1;
      pos = c === '\r' && text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
      QSEP.lastIndex = pos;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read
      // again as unquoted, with the line as it was when the field opened.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
      unquoted('"');
      return;
    }
    if (pos >= n) {
      fVal = val;
      fEnd = END;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fVal = val;
      fEnd = COMMA;
      fAdded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fVal = val;
      fEnd = LB;
      fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fVal = val;
      fEnd = LB;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or
    // line break; anything kept at all is quote_junk.
    unquoted(val);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let isQuoted = false;
    let end;
    do {
      if (text.charCodeAt(pos) === 34) {
        isQuoted = true;
        quoted();
      } else {
        isQuoted = false;
        unquoted('');
      }
      fields.push(fVal);
      end = fEnd;
    } while (end === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !isQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      fields.length = width;
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
