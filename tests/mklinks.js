// 링크 테스트용 PDF: 1쪽에 3쪽으로 가는 내부 링크와 웹 링크
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');
(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [];
  for (let i = 0; i < 5; i++) {
    const p = pdf.addPage([595, 842]);
    p.drawText(`Link Page ${i + 1}`, { x: 50, y: 780, size: 28, font });
    pages.push(p);
  }
  const p1 = pages[0];
  p1.drawText('Go to page 3', { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0.8) });
  p1.drawText('Open website', { x: 60, y: 640, size: 18, font, color: rgb(0, 0, 0.8) });
  const annots = pdf.context.obj([
    pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [55, 690, 260, 720], Border: [0, 0, 0], Dest: [pages[2].ref, PDFName.of('XYZ'), 0, 842, null] })),
    pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [55, 630, 260, 660], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/') } })),
  ]);
  p1.node.set(PDFName.of('Annots'), annots);
  require('fs').writeFileSync(process.argv[2], await pdf.save());
})();
