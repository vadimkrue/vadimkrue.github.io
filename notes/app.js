import { EditorState, EditorSelection, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { themeOverrides } from "./editor-theme.js";

/* ---------- Хранилище ---------- */

var STORAGE_KEY = "notes-app:content:v2";
var SAVE_DELAY_MS = 350;
var saveTimer = null;

function loadContent() {
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    return saved !== null ? saved : "";
  } catch (e) {
    console.warn("Не удалось прочитать localStorage:", e);
    return "";
  }
}

function writeToStorage(text) {
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch (e) {
    console.warn("Не удалось сохранить в localStorage:", e);
  }
}

function scheduleSave(text) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    saveTimer = null;
    writeToStorage(text);
  }, SAVE_DELAY_MS);
}

// Мгновенное сохранение без debounce — вызывается при уходе со страницы/
// потере фокуса, чтобы не потерять правки, для которых ещё не истекли 350мс.
function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (view) {
    writeToStorage(view.state.doc.toString());
  }
}

/* ---------- Команды форматирования (хоткеи) ---------- */

// Оборачивает выделение маркерами, либо снимает их, если они уже стоят
// вплотную к выделению (toggle). Паттерн — из официального форума CodeMirror
// (ответ автора библиотеки, Marijn Haverbeke): sliceDoc() перед/после range.
function wrapCommand(before, after) {
  return function (view) {
    view.dispatch(
      view.state.changeByRange(function (range) {
        var state = view.state;
        var hasBefore = state.sliceDoc(range.from - before.length, range.from) === before;
        var hasAfter = state.sliceDoc(range.to, range.to + after.length) === after;
        var alreadyWrapped = hasBefore && hasAfter;

        var changes = [];
        var deltaFrom, deltaTo;

        if (alreadyWrapped) {
          changes.push({ from: range.from - before.length, to: range.from });
          changes.push({ from: range.to, to: range.to + after.length });
          deltaFrom = -before.length;
          deltaTo = -before.length; // "to" сдвигается на то же значение, что и "from"
        } else {
          changes.push({ from: range.from, insert: before });
          changes.push({ from: range.to, insert: after });
          deltaFrom = before.length;
          deltaTo = before.length;
        }

        return {
          changes: changes,
          range: EditorSelection.range(range.from + deltaFrom, range.to + deltaTo),
        };
      })
    );
    return true;
  };
}

function forEachSelectedLine(view, fn) {
  var state = view.state;
  var changes = [];
  var seen = new Set();
  for (var range of state.selection.ranges) {
    var startLine = state.doc.lineAt(range.from).number;
    var endLine = state.doc.lineAt(range.to).number;
    for (var n = startLine; n <= endLine; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      var line = state.doc.line(n);
      var change = fn(line);
      if (change) changes.push(change);
    }
  }
  view.dispatch(state.update({ changes: changes }));
  return true;
}

function setHeadingCommand(level) {
  return function (view) {
    var state = view.state;
    var changes = [];
    var seen = new Set();

    for (var range of state.selection.ranges) {
      var startLine = state.doc.lineAt(range.from).number;
      var endLine = state.doc.lineAt(range.to).number;
      for (var n = startLine; n <= endLine; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        var line = state.doc.line(n);
        var match = /^(#{1,6}\s+)/.exec(line.text);
        var stripLen = match ? match[0].length : 0;
        var prefix = level === 0 ? "" : "#".repeat(level) + " ";
        changes.push({ from: line.from, to: line.from + stripLen, insert: prefix });
      }
    }

    if (!changes.length) return false;

    // Явно считаем позицию конца строки ПОСЛЕ применения изменений
    // (через mapPos), вместо того чтобы полагаться на дефолтный маппинг
    // старого выделения — именно это давало курсор в начале строки.
    var changeSet = state.changes(changes);
    var mainLineEnd = state.doc.lineAt(state.selection.main.to).to;
    var newCursorPos = changeSet.mapPos(mainLineEnd, 1);

    view.dispatch({
      changes: changes,
      selection: EditorSelection.cursor(newCursorPos),
      scrollIntoView: true,
    });
    return true;
  };
}

function toggleLinePrefixCommand(prefix, stripRegex) {
  return function (view) {
    return forEachSelectedLine(view, function (line) {
      var match = stripRegex.exec(line.text);
      if (match) {
        return { from: line.from, to: line.from + match[0].length };
      }
      return { from: line.from, insert: prefix };
    });
  };
}

var noteKeymap = [
  { key: "Mod-b", run: wrapCommand("**", "**") },
  { key: "Mod-i", run: wrapCommand("*", "*") },
  { key: "Mod-u", run: wrapCommand("<u>", "</u>") },
  { key: "Mod-Shift-x", run: wrapCommand("~~", "~~") },
  { key: "Mod-Alt-1", run: setHeadingCommand(1) },
  { key: "Mod-Alt-2", run: setHeadingCommand(2) },
  { key: "Mod-Alt-3", run: setHeadingCommand(3) },
  { key: "Mod-Alt-0", run: setHeadingCommand(0) },
  { key: "Mod-Shift-8", run: toggleLinePrefixCommand("- ", /^-\s+/) },
  { key: "Mod-Shift-7", run: toggleLinePrefixCommand("1. ", /^\d+\.\s+/) },
  { key: "Mod-Shift-.", run: toggleLinePrefixCommand("> ", /^>\s+/) },
];

/* ---------- Инициализация редактора ---------- */

// CodeMirror по умолчанию выключает spellcheck на своём contenteditable
// (логично для редактора кода) — для заметок включаем его явно.
var spellcheckAttrs = EditorView.contentAttributes.of({
  spellcheck: "true",
  autocapitalize: "sentences",
});

var startDoc = loadContent();

var state = EditorState.create({
  doc: startDoc,
  extensions: [
    history(),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    markdown({ codeLanguages: languages }),
    syntaxHighlighting(defaultHighlightStyle),
    placeholder("Начните печатать..."),
    EditorView.lineWrapping,
    spellcheckAttrs,
    themeOverrides,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    Prec.highest(keymap.of(noteKeymap)),
    EditorView.updateListener.of(function (update) {
      if (update.docChanged) {
        scheduleSave(update.state.doc.toString());
      }
    }),
  ],
});

var view = new EditorView({
  state: state,
  parent: document.getElementById("editor"),
});

view.focus();

// Три разных события ловят разные сценарии ухода со страницы:
// visibilitychange — переключение вкладки/сворачивание (в т.ч. на мобильных,
//   где beforeunload часто не срабатывает надёжно);
// pagehide — закрытие вкладки/переход по ссылке;
// beforeunload — как подстраховка для десктопных браузеров.
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "hidden") flushSave();
});
window.addEventListener("pagehide", flushSave);
window.addEventListener("beforeunload", flushSave); 