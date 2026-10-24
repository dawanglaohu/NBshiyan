import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'docs/brand-content/company-visuals.json');
const svgPath = 'docs/brand-content/source/dot-v3/PackJoyU-Company-Introduction-v3-EN.svg';
const pngPath = 'public/brand/company/company-introduction-v3-en.png';
const svgSha256 = 'd1ae945bcec1e5535838e1438f262252cf7b4d679c84402b57ebd8e54ffa687e';
const pngSha256 = '5d855fc087eb3fdca500718db6e1a64c00c80c8de2e04dc40e297683bdce611b';

const frozenArtwork = {
  id: 'company-introduction-v3-en',
  reference: {
    pdfPage: 2,
    theme: '仅参考公司概览、配套视觉与能力信息的组织层级；不移植YUHAO企业事实、照片或数字。',
  },
  factBasis:
    '用户在当前会话直接确认自有工厂、整合供应链、多品类定制、设计打样、质量把控全部为其提供的真实信息；12个品类名称来自src/data/products.ts。产品插画为概念示意，不代表真实厂房、设备或产品照片。',
  source: {
    path: svgPath,
    sha256: svgSha256,
  },
  web: {
    path: pngPath,
    sha256: pngSha256,
    width: 5000,
    height: 5800,
  },
  alt: {
    en: 'English PackJoyU company introduction with the official wordmark, conceptual packaging illustrations, company capabilities, a design-to-quality-control sequence, and a twelve-category product portfolio.',
    ru: 'Англоязычное представление PackJoyU: официальный логотип, условные иллюстрации упаковки, возможности компании, последовательность от дизайна до контроля качества и ассортимент из двенадцати категорий.',
  },
  logoImportObject: 'logo-master-import',
  editedObject: 'hero-title-1',
  productionRecord: 'docs/brand-content/source/dot-v3/receipt.json',
};

type HashEntry = { path?: string; sha256?: string };
type SelectedInput = { path?: string; sha256?: string; use?: string };
type Artwork = {
  id?: string;
  selectedInput?: SelectedInput;
  factBasis?: string;
  source?: HashEntry;
  web?: HashEntry & { width?: number; height?: number };
};
type Manifest = {
  logoMaster?: HashEntry;
  originalMedia?: HashEntry[];
  artworks?: Artwork[];
};

function sha256File(relativePath: string): string {
  return createHash('sha256').update(readFileSync(path.join(root, relativePath))).digest('hex');
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

function cloneManifest(manifest: Manifest): Manifest {
  return JSON.parse(JSON.stringify(manifest)) as Manifest;
}

function allowedInputs(manifest: Manifest): Map<string, string> {
  const allowed = new Map<string, string>();
  for (const item of manifest.originalMedia ?? []) {
    if (item.path && item.sha256) allowed.set(item.path, item.sha256);
  }
  if (manifest.logoMaster?.path && manifest.logoMaster.sha256) {
    allowed.set(manifest.logoMaster.path, manifest.logoMaster.sha256);
  }
  return allowed;
}

function assertSelectedInputs(manifest: Manifest): void {
  const artworks = manifest.artworks;
  if (!Array.isArray(artworks) || artworks.length === 0) {
    throw new Error('artworks missing');
  }
  const allowed = allowedInputs(manifest);
  for (const artwork of artworks) {
    const id = artwork.id ?? '<missing id>';
    const input = artwork.selectedInput;
    if (!input || typeof input.path !== 'string' || input.path.trim() === '') {
      throw new Error(`${id} selectedInput.path missing`);
    }
    if (path.win32.isAbsolute(input.path) || path.posix.isAbsolute(input.path) || input.path.split(/[/\\]/).includes('..')) {
      throw new Error(`${id} selectedInput.path escapes the repository`);
    }
    if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new Error(`${id} selectedInput.sha256 missing`);
    }
    if (typeof input.use !== 'string' || input.use.trim() === '') {
      throw new Error(`${id} selectedInput.use missing`);
    }
    if (/YUHAO|产能|规模|证照|认证|厂房|工厂/.test(input.use)) {
      throw new Error(`${id} selectedInput.use adds an unattested company fact`);
    }
    const catalogSha = allowed.get(input.path);
    if (catalogSha === undefined) {
      throw new Error(`${id} selectedInput.path is not originalMedia or logoMaster`);
    }
    if (input.sha256 !== catalogSha) {
      throw new Error(`${id} selectedInput.sha256 does not match catalog`);
    }
    if (sha256File(input.path) !== input.sha256) {
      throw new Error(`${id} selectedInput bytes hash mismatch`);
    }
  }
}

function assertDeliverableBytes(): void {
  if (sha256File(svgPath) !== svgSha256) throw new Error('source svg bytes changed');
  if (sha256File(pngPath) !== pngSha256) throw new Error('web png bytes changed');
}

function assertFrozenProse(manifest: Manifest): void {
  const artwork = manifest.artworks?.find((item) => item.id === frozenArtwork.id);
  if (!artwork) throw new Error('company-introduction-v3-en missing');
  const rest = JSON.parse(JSON.stringify(artwork)) as Record<string, unknown>;
  delete rest.selectedInput;
  if (JSON.stringify(rest) !== JSON.stringify(frozenArtwork)) {
    throw new Error('artwork prose or deliverable registration changed');
  }
}

test('每件公司图稿的选定输入指向已有字标或工业原件，且字节哈希相等', () => {
  const manifest = loadManifest();
  assertSelectedInputs(manifest);
  assertDeliverableBytes();
  assertFrozenProse(manifest);
  const artwork = manifest.artworks?.find((item) => item.id === frozenArtwork.id);
  assert.equal(artwork?.selectedInput?.path, manifest.logoMaster?.path);
  assert.equal(artwork?.selectedInput?.sha256, manifest.logoMaster?.sha256);
  assert.equal(artwork.source?.sha256, svgSha256);
  assert.equal(artwork.web?.sha256, pngSha256);
});

test('缺选定输入、空用途或空哈希时失败', () => {
  const missing = cloneManifest(loadManifest());
  delete missing.artworks?.[0]?.selectedInput;
  assert.throws(() => assertSelectedInputs(missing), /selectedInput\.path missing/);

  const blankUse = cloneManifest(loadManifest());
  const blank = blankUse.artworks?.[0]?.selectedInput;
  assert.ok(blank);
  blank.use = '   ';
  assert.throws(() => assertSelectedInputs(blankUse), /selectedInput\.use missing/);

  const blankSha = cloneManifest(loadManifest());
  const sha = blankSha.artworks?.[0]?.selectedInput;
  assert.ok(sha);
  sha.sha256 = '';
  assert.throws(() => assertSelectedInputs(blankSha), /selectedInput\.sha256 missing/);
});

test('选定输入哈希与目录或文件字节不一致时失败', () => {
  const catalogMismatch = cloneManifest(loadManifest());
  const catalogInput = catalogMismatch.artworks?.[0]?.selectedInput;
  assert.ok(catalogInput);
  catalogInput.sha256 = '0'.repeat(64);
  assert.throws(() => assertSelectedInputs(catalogMismatch), /does not match catalog/);

  const byteMismatch = cloneManifest(loadManifest());
  const byteInput = byteMismatch.artworks?.[0]?.selectedInput;
  assert.ok(byteInput && byteMismatch.logoMaster);
  const wrong = 'f'.repeat(64);
  byteInput.sha256 = wrong;
  byteMismatch.logoMaster.sha256 = wrong;
  assert.throws(() => assertSelectedInputs(byteMismatch), /bytes hash mismatch/);
});

test('选定输入不能指向工程、Web 图或清单外路径', () => {
  const webTarget = cloneManifest(loadManifest());
  const input = webTarget.artworks?.[0]?.selectedInput;
  const web = webTarget.artworks?.[0]?.web;
  assert.ok(input && web?.path && web.sha256);
  input.path = web.path;
  input.sha256 = web.sha256;
  assert.throws(() => assertSelectedInputs(webTarget), /not originalMedia or logoMaster/);
});

test('选定输入用途或图稿正文新增未证实企业事实时失败', () => {
  const claimedUse = cloneManifest(loadManifest());
  const input = claimedUse.artworks?.[0]?.selectedInput;
  assert.ok(input);
  input.use = `${input.use}产能与YUHAO认证`;
  assert.throws(() => assertSelectedInputs(claimedUse), /unattested company fact/);

  const claimedBasis = cloneManifest(loadManifest());
  const artwork = claimedBasis.artworks?.[0];
  assert.ok(artwork);
  artwork.factBasis = `${artwork.factBasis}厂房证照`;
  assert.throws(() => assertFrozenProse(claimedBasis), /prose or deliverable registration changed/);
});
