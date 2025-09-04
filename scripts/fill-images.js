const fs = require("fs");
const path = require("path");

const CATALOG_ROOT = path.resolve(__dirname, "../assets/catalog");
const TYPES = ["ring", "earrings", "necklace"];
const SHAPES = ["round", "princess", "cushion"];
const COLORS = ["white", "yellow", "pink"];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith("."))
      .map((f) => path.join(dir, f))
      .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  } catch (_) {
    return [];
  }
}

function findImageCandidate(dir) {
  const files = listFiles(dir);
  const preferred = files.find((f) => /image\.(jpg|jpeg|png)$/i.test(f));
  if (preferred) return preferred;
  const anyImg = files.find((f) => /(\.png|\.jpe?g)$/i.test(f));
  return anyImg || null;
}

function copyAsImageJpg(srcFile, targetDir) {
  ensureDir(targetDir);
  const target = path.join(targetDir, "image.jpg");
  if (!srcFile) return false;
  try {
    fs.copyFileSync(srcFile, target);
    return true;
  } catch (e) {
    console.error("Не удалось скопировать", srcFile, "→", target, e.message);
    return false;
  }
}

function findFallbackFor(type, shape, color) {
  const dirExact = path.join(CATALOG_ROOT, type, shape, color);
  const dirShape = path.join(CATALOG_ROOT, type, shape);
  const dirType = path.join(CATALOG_ROOT, type);

  // 1) В самом целевом каталоге
  let c = findImageCandidate(dirExact);
  if (c) return c;

  // 2) На уровне shape без цвета (на случай, как с necklace/princess/1.png)
  c = findImageCandidate(dirShape);
  if (c) return c;

  // 3) Любой другой цвет этой же формы
  for (const otherColor of COLORS) {
    if (otherColor === color) continue;
    c = findImageCandidate(path.join(CATALOG_ROOT, type, shape, otherColor));
    if (c) return c;
  }

  // 4) Любая другая форма этого же типа
  for (const otherShape of SHAPES) {
    if (otherShape === shape) continue;
    // сначала уровень цвета
    for (const anyColor of COLORS) {
      c = findImageCandidate(
        path.join(CATALOG_ROOT, type, otherShape, anyColor)
      );
      if (c) return c;
    }
    // затем уровень формы без цвета
    c = findImageCandidate(path.join(CATALOG_ROOT, type, otherShape));
    if (c) return c;
  }

  // 5) Любая картинка в пределах этого типа
  c = findImageCandidate(dirType);
  if (c) return c;

  // 6) Глобальный фолбэк: любая картинка в каталоге
  let global = null;
  for (const t of TYPES) {
    for (const s of SHAPES) {
      for (const col of COLORS) {
        global = findImageCandidate(path.join(CATALOG_ROOT, t, s, col));
        if (global) return global;
      }
      global = findImageCandidate(path.join(CATALOG_ROOT, t, s));
      if (global) return global;
    }
    global = findImageCandidate(path.join(CATALOG_ROOT, t));
    if (global) return global;
  }
  return null;
}

function main() {
  let created = 0;
  let skipped = 0;
  for (const type of TYPES) {
    for (const shape of SHAPES) {
      for (const color of COLORS) {
        const targetDir = path.join(CATALOG_ROOT, type, shape, color);
        ensureDir(targetDir);
        const already = path.join(targetDir, "image.jpg");
        if (fs.existsSync(already)) {
          skipped++;
          continue;
        }
        const src = findFallbackFor(type, shape, color);
        if (src && copyAsImageJpg(src, targetDir)) {
          created++;
          console.log(
            `✓ ${type}/${shape}/${color} ← ${path.relative(CATALOG_ROOT, src)}`
          );
        } else {
          console.warn(`⚠ Не найден источник для ${type}/${shape}/${color}`);
        }
      }
    }
  }
  console.log(`Готово. Создано: ${created}, пропущено (уже было): ${skipped}`);
}

main();
