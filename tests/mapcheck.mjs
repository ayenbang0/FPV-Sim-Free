/**
 * tests/mapcheck.mjs
 * Shared helpers for headless map validation: exact point-in-collider tests
 * (not AABB approximations, which rotated beams would swamp with false hits).
 */
import * as CANNON from 'cannon-es';

const _v = new CANNON.Vec3();
const _l = new CANNON.Vec3();
const _q = new CANNON.Quaternion();

/** Distance by which point p is inside `body` (≤0 = outside). Approximate for cylinders. */
export function penetration(body, p, margin = 0) {
  let best = -Infinity;
  for (let i = 0; i < body.shapes.length; i++) {
    const shape = body.shapes[i];
    const off = body.shapeOffsets[i];
    // World → body local → shape local.
    _v.set(p.x - body.position.x, p.y - body.position.y, p.z - body.position.z);
    body.quaternion.conjugate(_q);
    _q.vmult(_v, _l);
    _l.vsub(off, _l);
    const so = body.shapeOrientations[i];
    so.conjugate(_q);
    _q.vmult(_l, _l);
    let pen = -Infinity;
    if (shape instanceof CANNON.Box) {
      const h = shape.halfExtents;
      pen = Math.min(h.x + margin - Math.abs(_l.x), h.y + margin - Math.abs(_l.y), h.z + margin - Math.abs(_l.z));
    } else if (shape instanceof CANNON.Sphere) {
      pen = shape.radius + margin - Math.hypot(_l.x, _l.y, _l.z);
    } else if (shape instanceof CANNON.Cylinder) {
      const r = Math.max(shape.radiusTop, shape.radiusBottom);
      pen = Math.min(r + margin - Math.hypot(_l.x, _l.z), shape.height / 2 + margin - Math.abs(_l.y));
    } else if (shape instanceof CANNON.Heightfield) {
      // Local frame: x along i, y along j, height along z.
      const es = shape.elementSize;
      const i0 = Math.floor(_l.x / es);
      const j0 = Math.floor(_l.y / es);
      const d = shape.data;
      if (i0 >= 0 && j0 >= 0 && i0 < d.length - 1 && j0 < d[0].length - 1) {
        const h = Math.max(d[i0][j0], d[i0 + 1][j0], d[i0][j0 + 1], d[i0 + 1][j0 + 1]);
        pen = h + margin - _l.z;
      }
    } else if (shape instanceof CANNON.Plane) {
      pen = margin - _l.z;
    }
    if (pen > best) best = pen;
  }
  return best;
}

/** Every static collider the physics world knows about, live or streamed-in. */
export function staticBodies(physics) {
  return Array.from(physics.trackedBodies).filter((b) => b.mass === 0);
}

export function blockedAt(bodies, p, margin = 0) {
  return bodies.filter((b) => penetration(b, p, margin) > 0);
}
