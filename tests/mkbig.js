const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < 300; i++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`Big ${i + 1}`, { x: 50, y: 780, size: 28, font });
    for (let k = 0; k < 400; k++) page.drawLine({ start: { x: 40 + (k * 13) % 500, y: 60 + (k * 7) % 680 }, end: { x: 60 + (k * 17) % 500, y: 80 + (k * 11) % 680 }, thickness: 0.5, color: rgb((k % 7) / 7, 0.3, 0.5) });
    for (let y = 740; y > 60; y -= 14) page.drawText('The quick brown fox jumps over the lazy dog ' + i + ' ' + y, { x: 50, y, size: 10, font });
  }
  require('fs').writeFileSync(process.argv[2], await pdf.save());
})();
