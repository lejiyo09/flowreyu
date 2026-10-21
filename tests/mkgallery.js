// 크롬북 갤러리가 필기를 저장하는 모양을 흉내 낸 테스트 PDF:
// 원래 내용(글자) + 덧붙인 내용 스트림 안의 /GOOG:INKIsInker 표시, 획마다 채운 다각형, 형광펜은 /ca 0.4 ExtGState
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb, PDFName } = require('pdf-lib');
(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText('Gallery ink test page', { x: 60, y: 760, size: 28, font, color: rgb(0.1, 0.1, 0.4) });
  for (let i = 0; i < 12; i++) page.drawText(`Line ${i + 1} of original document text`, { x: 60, y: 700 - i * 30, size: 14, font });
  const gs1 = pdf.context.register(pdf.context.obj({ BM: 'Normal', CA: 1, ca: 1 }));
  const gs2 = pdf.context.register(pdf.context.obj({ ca: 0.40000001 }));
  page.node.setExtGState(PDFName.of('FXE1'), gs1);
  page.node.setExtGState(PDFName.of('FXE2'), gs2);
  // 펜 획: (100,500)~(300,500) 근처 두께 6 의 띠 / 형광펜: (100,400)~(400,420) 사각형 띠
  const pen = '100 503 m 300 503 l 303 500 l 300 497 l 100 497 l 97 500 l h f';
  const hl = '100 410 m 400 410 l 400 430 l 100 430 l h f';
  const ink = `q\n0 0 0 RG 0 0 0 rg 1 w 0 J 0 j\n/FXE1 gs /GOOG:INKIsInker BMC\nq 0 0 0 rg 0 0 0 RG ${pen} Q\nq .94901961 .54509807 .50980395 rg 0 0 0 RG /FXE2 gs ${hl} Q\nEMC\nQ\n`;
  page.node.addContentStream(pdf.context.register(pdf.context.flateStream(ink)));
  fs.writeFileSync(process.argv[2], await pdf.save({ useObjectStreams: false }));
  console.log('wrote', process.argv[2]);
})();
