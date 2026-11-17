'use strict';

// 由 media/src 下的高清源图生成官网截图所需的演示素材（视频 / 图片 / 文档）。
// 用法：node website/scripts/capture/prepare-media.cjs
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const FFMPEG = path.join(ROOT, 'bin', 'ffmpeg.exe');
const SRC = path.join(__dirname, 'media', 'src');
const OUT = path.join(__dirname, 'media');
const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));

function ff(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}
function pick(base) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const p = path.join(SRC, `${base}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('缺少源图: ' + base);
}
const o = (n) => path.join(OUT, n);

// 1. 风景照 → 1920×1080 JPG + 7 秒缓慢推拉 1080p MP4
ff(['-i', pick('landscape'), '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080', '-q:v', '3', o('landscape.jpg')]);
ff([
  '-loop', '1', '-framerate', '30', '-i', o('landscape.jpg'),
  '-vf', [
    'scale=3840:2160',
    "zoompan=z='1+0.12*on/210':x='(iw-iw/zoom)*(0.35+0.3*on/210)':y='(ih-ih/zoom)/2':d=210:s=1920x1080:fps=30",
    'format=yuv420p',
  ].join(','),
  '-frames:v', '210', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', o('city.mp4'),
]);

// 2. 绿幕角色 → JPG + 4 秒轻微推近 MP4（绿幕视频）
ff(['-i', pick('greenscreen'), '-vf', "scale='min(1600,iw)':-2", '-q:v', '2', o('greenscreen.jpg')]);
ff([
  '-loop', '1', '-framerate', '30', '-i', o('greenscreen.jpg'),
  '-vf', "scale=1920:-2,zoompan=z='1+0.06*on/120':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=120:s=1280x720:fps=30,format=yuv420p",
  '-frames:v', '120', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', o('greenscreen.mp4'),
]);

// 3. 扁平 Logo → 1024 PNG
ff(['-i', pick('logo-flat'), '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', o('logo.png')]);

// 4. 产品照 → 1600 宽 JPG
ff(['-i', pick('portrait'), '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', o('product.jpg')]);

// 5. 背景音乐（简单和弦合成，供"配乐"模板输入节点使用）
ff([
  '-f', 'lavfi', '-i', "aevalsrc='0.18*sin(2*PI*261.6*t)*(1-mod(t,1)/1.4)+0.14*sin(2*PI*329.6*t)*(1-mod(t+0.5,1)/1.4)+0.12*sin(2*PI*392*t)':s=44100:d=8",
  '-af', 'afade=t=in:d=0.5,afade=t=out:st=7:d=1', '-c:a', 'aac', '-b:a', '128k', o('bgm.m4a'),
]);

// 6. 含 4 张图片的 Word 文档（用于"文档提取图片"演示）
const thumbs = [
  ['image1.jpg', o('landscape.jpg')],
  ['image2.jpg', o('product.jpg')],
  ['image3.png', o('logo.png')],
  ['image4.jpg', o('greenscreen.jpg')],
];
const zip = new AdmZip();
zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, 'utf8'));
zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'));
zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${thumbs.map(([n], i) => `  <Relationship Id="rId${i + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${n}"/>`).join('\n')}
</Relationships>`, 'utf8'));
const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const pic = (i) => `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="5486400" cy="3086100"/><wp:docPr id="${i + 1}" name="图片 ${i + 1}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${i + 1}" name="图片 ${i + 1}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${i + 10}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
const titles = ['一、城市风光', '二、产品摄影', '三、品牌标识', '四、吉祥物设计'];
zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${para('品牌宣传素材汇编')}${thumbs.map((_, i) => para(titles[i]) + pic(i)).join('')}</w:body>
</w:document>`, 'utf8'));
for (const [n, p] of thumbs) {
  // 文档内嵌图统一缩到 1280 宽，控制 docx 体积
  const tmp = path.join(OUT, `__doc_${n}`);
  ff(['-i', p, '-vf', "scale='min(1280,iw)':-2", ...(n.endsWith('.jpg') ? ['-q:v', '4'] : []), tmp]);
  zip.addFile(`word/media/${n}`, fs.readFileSync(tmp));
  fs.unlinkSync(tmp);
}
zip.writeZip(o('brochure.docx'));

for (const f of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, f));
  if (st.isFile()) console.log(`${f}\t${(st.size / 1024).toFixed(1)} KB`);
}
