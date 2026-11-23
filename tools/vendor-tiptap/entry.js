// FlexNote 타이핑형 노트에 쓰는 편집기 모듈 묶음 (vendor/tiptap/tiptap.mjs 로 빌드)
export { Editor, Extension, Node, Mark, mergeAttributes } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { TextStyleKit } from '@tiptap/extension-text-style';
export { default as TextAlign } from '@tiptap/extension-text-align';
export { TableKit } from '@tiptap/extension-table';
export { default as Image } from '@tiptap/extension-image';
export { default as Highlight } from '@tiptap/extension-highlight';
export { default as Subscript } from '@tiptap/extension-subscript';
export { default as Superscript } from '@tiptap/extension-superscript';
export { Mathematics } from '@tiptap/extension-mathematics';
export { Plugin, PluginKey, TextSelection, NodeSelection } from '@tiptap/pm/state';
export { Decoration, DecorationSet } from '@tiptap/pm/view';
export { DOMParser as PMDOMParser, DOMSerializer as PMDOMSerializer } from '@tiptap/pm/model';
