'use strict';
/**
 * J7 共用摘要实现（唯一一份）。探针、收件生产与校验器都 require 本文件，
 * 避免三处各写一份导致"同一棵树两个摘要"。
 *
 * 规范：
 *   treeDigest(dir) = sha256( 每行 `${relPath}\t${size}\t${fileSha256}\n`，按 relPath 字节序排序 )
 *   clusterDigest(systemIdentifier) = sha256(`system_identifier:${value}`)
 * 只读；不写任何文件。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256FileSync(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function walk(root, prefix, out) {
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      out.push({ rel, size: -1 });
      continue;
    }
    if (entry.isDirectory()) {
      walk(root, rel, out);
      continue;
    }
    if (entry.isFile()) {
      out.push({ rel, size: fs.statSync(path.join(root, rel)).size });
      continue;
    }
    out.push({ rel, size: -2 });
  }
}

/** 目录整树摘要。符号链接直接失败：standalone 树不该含链接，含链接时摘要无意义。 */
async function treeDigest(dir) {
  const root = path.resolve(dir);
  const rows = [];
  walk(root, '', rows);
  if (rows.some((row) => row.size < 0)) {
    const bad = rows.filter((row) => row.size < 0).map((row) => row.rel).slice(0, 3);
    throw new Error(`J7_TREE_SPECIAL_FILE:${bad.join(',')}`);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')));
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    const digest = await sha256File(path.join(root, row.rel));
    hash.update(`${row.rel}\t${row.size}\t${digest}\n`, 'utf8');
  }
  return { sha256: hash.digest('hex'), files: rows.length };
}

function clusterDigest(systemIdentifier) {
  return sha256Text(`system_identifier:${systemIdentifier}`);
}

/** 同步版整树摘要，供收件生产/校验器使用；规范与 treeDigest 完全相同。 */
function treeDigestSync(dir) {
  const root = path.resolve(dir);
  const rows = [];
  walk(root, '', rows);
  if (rows.some((row) => row.size < 0)) {
    const bad = rows.filter((row) => row.size < 0).map((row) => row.rel).slice(0, 3);
    throw new Error(`J7_TREE_SPECIAL_FILE:${bad.join(',')}`);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')));
  const hash = crypto.createHash('sha256');
  for (const row of rows) hash.update(`${row.rel}\t${row.size}\t${sha256FileSync(path.join(root, row.rel))}\n`, 'utf8');
  return { sha256: hash.digest('hex'), files: rows.length };
}

/** RFC 6238 TOTP（base32、SHA-1、6 位、30 秒），与 e2e 已用的 otplib 默认参数一致。 */
function totp(secretBase32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(secretBase32).toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('J7_TOTP_SECRET');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  if (bytes.length === 0) throw new Error('J7_TOTP_SECRET');
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(at / 1000 / 30), 4);
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

module.exports = { sha256Text, sha256Buffer, sha256File, sha256FileSync, treeDigest, treeDigestSync, clusterDigest, totp };
