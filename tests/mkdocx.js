// DOCX 시험 파일: 제목·글자 서식·표(가로·세로 병합, 배경, 가운데 정렬)·그림·링크·목록·탭 채움선(목차)·쪽 나눔·
// 머리글·바닥글 쪽 번호·각주·메모(지원하지 않는 요소 알림 확인용) — 실제 Word 형식(OOXML)으로 만든다
const fs = require('fs');
const path = require('path');
const d = require('docx');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/img.png'));
const cell = (text, o = {}) => new d.TableCell({ children: [new d.Paragraph({ children: [new d.TextRun({ text, bold: o.bold })], alignment: o.center ? d.AlignmentType.CENTER : undefined })], columnSpan: o.span, rowSpan: o.rows, shading: o.fill ? { fill: o.fill, type: d.ShadingType.CLEAR, color: 'auto' } : undefined, verticalAlign: o.middle ? d.VerticalAlign.CENTER : undefined, width: o.w ? { size: o.w, type: d.WidthType.DXA } : undefined });
const doc = new d.Document({
  comments: { children: [{ id: 0, author: '검토자', date: new Date(2026, 0, 1), children: [new d.Paragraph('확인 필요')] }] },
  footnotes: { 1: { children: [new d.Paragraph('각주 내용입니다.')] } },
  numbering: { config: [{ reference: 'num', levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: '%1.', alignment: d.AlignmentType.LEFT }] }] },
  styles: { default: { document: { run: { font: '맑은 고딕', size: 21 } } } },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 850, left: 1701, right: 1701 } } },
    headers: { default: new d.Header({ children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun('연구 보고서 머리글')] })] }) },
    footers: { default: new d.Footer({ children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ children: [d.PageNumber.CURRENT] })] })] }) },
    children: [
      new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, alignment: d.AlignmentType.CENTER, children: [new d.TextRun('시험 문서 제목')] }),
      new d.Paragraph({ children: [
        new d.TextRun('보통 '), new d.TextRun({ text: '굵게', bold: true }), new d.TextRun(' '), new d.TextRun({ text: '기울임', italics: true }), new d.TextRun(' '),
        new d.TextRun({ text: '밑줄', underline: {} }), new d.TextRun(' '), new d.TextRun({ text: '빨강14pt', color: 'C00000', size: 28 }), new d.TextRun(' '),
        new d.TextRun({ text: '형광', highlight: 'yellow' }), new d.TextRun(' H'), new d.TextRun({ text: '2', subScript: true }), new d.TextRun('O'),
        new d.CommentRangeStart(0), new d.TextRun(' 메모 붙은 글'), new d.CommentRangeEnd(0), new d.TextRun({ children: [new d.CommentReference(0)] }),
        new d.TextRun(' 각주'), new d.FootnoteReferenceRun(1),
      ] }),
      new d.Paragraph({ children: [new d.ExternalHyperlink({ link: 'https://example.com/report', children: [new d.TextRun({ text: '링크 글자', style: 'Hyperlink' })] })] }),
      new d.Paragraph({ tabStops: [{ type: d.TabStopType.RIGHT, position: 8504, leader: d.LeaderType.DOT }], children: [new d.TextRun('1. 서론'), new d.TextRun('\t3')] }),
      new d.Paragraph({ tabStops: [{ type: d.TabStopType.RIGHT, position: 8504, leader: d.LeaderType.DOT }], children: [new d.TextRun('2. 본론'), new d.TextRun({ children: [new d.Tab(), '5'] })] }),
      new d.Paragraph({ bullet: { level: 0 }, children: [new d.TextRun('글머리 하나')] }),
      new d.Paragraph({ bullet: { level: 0 }, children: [new d.TextRun('글머리 둘')] }),
      new d.Paragraph({ numbering: { reference: 'num', level: 0 }, children: [new d.TextRun('번호 하나')] }),
      new d.Paragraph({ numbering: { reference: 'num', level: 0 }, children: [new d.TextRun('번호 둘')] }),
      new d.Table({ alignment: d.AlignmentType.CENTER, width: { size: 6000, type: d.WidthType.DXA }, columnWidths: [2000, 2000, 2000], rows: [
        new d.TableRow({ tableHeader: true, children: [cell('구분', { fill: 'D9E2F3', bold: true, center: true, w: 2000 }), cell('가로 병합', { span: 2, fill: 'D9E2F3', bold: true, center: true, w: 4000 })] }),
        new d.TableRow({ children: [cell('세로 병합', { rows: 2, middle: true, w: 2000 }), cell('A1', { w: 2000 }), cell('B1', { w: 2000 })] }),
        new d.TableRow({ children: [cell('A2', { w: 2000 }), cell('B2', { w: 2000 })] }),
      ] }),
      new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.ImageRun({ type: 'png', data: png, transformation: { width: 160, height: 80 } })] }),
      new d.Paragraph({ pageBreakBefore: true, heading: d.HeadingLevel.HEADING_2, children: [new d.TextRun('새 쪽에서 시작하는 제목')] }),
      new d.Paragraph({ spacing: { after: 240, line: 360 }, indent: { left: 400 }, children: [new d.TextRun('들여쓰기 400·줄 간격 1.5·문단 뒤 12pt 문단입니다.')] }),
      new d.Paragraph({ children: [new d.TextRun('쪽 나눔 문자 앞'), new d.PageBreak(), new d.TextRun('쪽 나눔 문자 뒤')] }),
    ],
  }],
});
d.Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(process.argv[2], buf); console.log('wrote', process.argv[2]); });
