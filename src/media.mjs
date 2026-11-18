// Confere e prepara imagens e vídeos antes de enviar: proporção, tamanho e formato que o Instagram aceita.
// Converte com o sips (já vem no macOS) ou com o ffmpeg, quando estiver instalado.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
export const LIMITS = {
  minRatio: 0.8, maxRatio: 1.91, minWidth: 320, maxWidth: 1440,
  maxImageBytes: 8 * 1024 * 1024, maxUploadBytes: 50 * 1024 * 1024, compressTargetBytes: 45 * 1024 * 1024,
  minSeconds: 3, maxSeconds: 900,
};
const MB = 1024 * 1024;

function jpegOrientation(buffer, start, length) {
  if (buffer.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1;
  const tiff = start + 6;
  const little = buffer.toString('latin1', tiff, tiff + 2) === 'II';
  const read16 = offset => (little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const read32 = offset => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const directory = tiff + read32(tiff + 4);
  if (directory + 2 > start + length) return 1;
  const entries = read16(directory);
  for (let index = 0; index < entries; index++) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > start + length) break;
    if (read16(entry) === 0x0112) return read16(entry + 8);
  }
  return 1;
}

function jpegSize(buffer) {
  let offset = 2;
  let orientation = 1;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe1) orientation = jpegOrientation(buffer, offset + 4, length - 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { format: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7), orientation };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer) {
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { format: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { format: 'webp', width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  return null;
}

// Lê largura e altura direto do arquivo (JPEG, PNG ou WebP), sem programa externo.
export function imageSize(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return jpegSize(buffer);
  if (buffer.length > 24 && buffer.toString('latin1', 1, 4) === 'PNG') {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return webpSize(buffer);
  }
  return null;
}

// Fotos de celular guardam a rotação no EXIF: a proporção que aparece é a girada.
export function displaySize(info) {
  return info.orientation >= 5 && info.orientation <= 8 ? { width: info.height, height: info.width } : info;
}

export function checkImage(info, index) {
  const label = `Imagem ${index + 1}`;
  if (!(info?.width > 0 && info?.height > 0)) throw new Error(`${label}: não consegui ler as dimensões. Exporte em JPG.`);
  const { width, height } = displaySize(info);
  const ratio = width / height;
  if (ratio < LIMITS.minRatio - 0.005 || ratio > LIMITS.maxRatio + 0.005) {
    throw new Error(`${label}: ${width} × ${height} está fora do que o Instagram aceita no feed (de 4:5 vertical a 1,91:1 horizontal). `
      + 'Para carrossel e foto, exporte em 1080 × 1350 (4:5) ou 1080 × 1080 (1:1).');
  }
  if (width < LIMITS.minWidth) throw new Error(`${label}: a largura mínima é ${LIMITS.minWidth} px.`);
}

export function commandExists(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [name], { stdio: 'ignore' }).status === 0;
}

// JPEG que já serve vai como está; o resto é convertido (e reduzido a 1440 px de largura).
export function convertImage(source, target, width, tools = { sips: commandExists('sips'), ffmpeg: commandExists('ffmpeg') }) {
  const resize = width > LIMITS.maxWidth;
  if (tools.sips) {
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', ...(resize ? ['--resampleWidth', String(LIMITS.maxWidth)] : [])];
    execFileSync('sips', [...args, source, '--out', target], { stdio: 'ignore' });
    return;
  }
  if (tools.ffmpeg) {
    const scale = resize ? ['-vf', `scale=${LIMITS.maxWidth}:-2`] : [];
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, ...scale, '-q:v', '3', target], { stdio: 'ignore' });
    return;
  }
  throw new Error('Para converter PNG, WebP ou HEIC preciso do sips (macOS) ou do ffmpeg. Outra saída: exporte as imagens em JPG.');
}

export function prepareImage(file, index, workDir, convert = convertImage) {
  if (!fs.existsSync(file)) throw new Error(`Imagem ${index + 1}: o arquivo ${file} não existe.`);
  const original = imageSize(fs.readFileSync(file));
  if (original) checkImage(original, index);
  const target = path.join(workDir, `${String(index + 1).padStart(2, '0')}.jpg`);
  const bytes = fs.statSync(file).size;
  const ready = original?.format === 'jpeg' && original.width <= LIMITS.maxWidth && bytes <= LIMITS.maxImageBytes;
  if (ready) fs.copyFileSync(file, target);
  else convert(file, target, original?.width || 0);
  let final = imageSize(fs.readFileSync(target));
  if (final && final.width > LIMITS.maxWidth) {
    // Formato que eu não leio antes (HEIC): reduz depois da primeira conversão.
    const resized = `${target}.reduzida.jpg`;
    convert(target, resized, final.width);
    fs.renameSync(resized, target);
    final = imageSize(fs.readFileSync(target));
  }
  checkImage(final, index);
  const size = fs.statSync(target).size;
  if (size > LIMITS.maxImageBytes) throw new Error(`Imagem ${index + 1}: ${(size / MB).toFixed(1)} MB depois da conversão; o Instagram aceita até 8 MB.`);
  return { source: file, file: target, ...displaySize(final), bytes: size, rotated: (final.orientation || 1) !== 1 };
}

export function prepareImages(files, workDir, convert) {
  const images = files.map((file, index) => prepareImage(file, index, workDir, convert));
  const warnings = [];
  const ratios = new Set(images.map(image => (image.width / image.height).toFixed(2)));
  if (images.length > 1 && ratios.size > 1) {
    warnings.push('As imagens têm proporções diferentes: no carrossel, o Instagram corta todas pela proporção da primeira.');
  }
  if (images.some(image => image.rotated)) {
    warnings.push('Há foto com rotação guardada no EXIF. Se aparecer de lado no teste, exporte de novo já na posição certa.');
  }
  return { images, warnings };
}

export function probeVideo(file) {
  if (!commandExists('ffprobe')) return null;
  const output = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
    '-of', 'json', file], { encoding: 'utf8' });
  const data = JSON.parse(output);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const audio = data.streams.find(stream => stream.codec_type === 'audio');
  return { videoCodec: video?.codec_name, audioCodec: audio?.codec_name || null, width: video?.width, height: video?.height,
    seconds: Number(data.format?.duration) };
}

// Problemas que travam a publicação viram erro; o resto vira aviso.
export function checkVideo(info, bytes) {
  const warnings = [];
  if (!info) {
    warnings.push('Sem ffprobe para conferir o vídeo antes; o Instagram confere no teste.');
    return warnings;
  }
  if (!['h264', 'hevc'].includes(info.videoCodec)) throw new Error(`Vídeo em ${info.videoCodec || 'formato desconhecido'}; o Instagram aceita H.264 ou HEVC. Use --comprimir para converter.`);
  if (info.audioCodec && info.audioCodec !== 'aac') throw new Error(`Áudio em ${info.audioCodec}; o Instagram aceita AAC. Use --comprimir para converter.`);
  if (!(info.seconds >= LIMITS.minSeconds && info.seconds <= LIMITS.maxSeconds)) throw new Error(`Vídeo de ${Math.round(info.seconds)} s; o Reels vai de 3 s a 15 min.`);
  if (!(info.height > info.width)) warnings.push(`Vídeo de ${info.width} × ${info.height}: o Reels aparece melhor na vertical (1080 × 1920).`);
  if (bytes > LIMITS.maxUploadBytes) throw new Error(`Vídeo de ${Math.round(bytes / MB)} MB; o plano grátis do Supabase aceita até 50 MB por arquivo. Rode de novo com --comprimir.`);
  return warnings;
}

// Recomprime para caber em ~45 MB: H.264 + AAC, até 1080 de largura, com início rápido.
export function compressVideo(source, target, seconds) {
  if (!commandExists('ffmpeg')) throw new Error('Para comprimir o vídeo preciso do ffmpeg (macOS: brew install ffmpeg).');
  const audioBits = 128000;
  const videoBits = Math.max(800000, Math.floor((LIMITS.compressTargetBytes * 8) / Math.max(seconds, 1) - audioBits));
  const rate = String(Math.min(videoBits, 6000000));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, '-vf', "scale='min(1080,iw)':-2", '-c:v', 'libx264',
    '-preset', 'medium', '-b:v', rate, '-maxrate', rate, '-bufsize', String(Number(rate) * 2), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', String(audioBits), '-movflags', '+faststart', target], { stdio: 'ignore' });
}

export function prepareVideo(file, workDir, { compress = false, probe = probeVideo, shrink = compressVideo } = {}) {
  if (!fs.existsSync(file)) throw new Error(`O vídeo ${file} não existe.`);
  let source = file;
  let info = probe(file);
  const needsMp4 = path.extname(file).toLowerCase() !== '.mp4';
  if (compress || needsMp4) {
    if (!info && !commandExists('ffmpeg')) throw new Error('Para converter o vídeo em MP4 preciso do ffmpeg (macOS: brew install ffmpeg).');
    source = path.join(workDir, 'video.mp4');
    shrink(file, source, info?.seconds || 60);
    info = probe(source);
  }
  const bytes = fs.statSync(source).size;
  const warnings = checkVideo(info, bytes);
  return { file: source, info, bytes, warnings };
}
