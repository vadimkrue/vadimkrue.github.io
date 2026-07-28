import { EditorView } from "@codemirror/view";

// Точечные переопределения дефолтной темы CodeMirror (не полная кастомная
// тема — только конкретные вещи, о которых просили убрать/поменять).
//
// Через EditorView.theme(), а не обычный внешний .css: CodeMirror сам
// генерирует и вставляет свои стили в рантайме, уже после загрузки
// страницы — обычный <link rel="stylesheet"> оказался бы раньше в
// каскаде и проигрывал бы дефолтным стилям CodeMirror при равной
// специфичности. EditorView.theme гарантирует правильный порядок
// без !important.
export var themeOverrides = EditorView.theme({
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { backgroundColor: "transparent" },
  "&": {
    fontSize: "clamp(16px, 1vw, 32px)",
  },
  ".cm-content": {
    fontFamily: "'IBM Plex Sans', sans-serif",
  },
});
