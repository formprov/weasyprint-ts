// SPDX-License-Identifier: BSD-3-Clause

/** Draw simple shapes (mirrors weasyprint/svg/shapes.py). */
import { normalize, point } from './utils.ts';

export function circle(svg: any, node: any, fontSize: number): void {
  const r = svg.length(node.get('r'), fontSize);
  if (!r) return;
  const ratio = r / Math.sqrt(Math.PI);
  const [cx, cy] = svg.point(node.get('cx'), node.get('cy'), fontSize);

  svg.stream.moveTo(cx + r, cy);
  svg.stream.curveTo(cx + r, cy + ratio, cx + ratio, cy + r, cx, cy + r);
  svg.stream.curveTo(cx - ratio, cy + r, cx - r, cy + ratio, cx - r, cy);
  svg.stream.curveTo(cx - r, cy - ratio, cx - ratio, cy - r, cx, cy - r);
  svg.stream.curveTo(cx + ratio, cy - r, cx + r, cy - ratio, cx + r, cy);
  svg.stream.close();
}

export function ellipse(svg: any, node: any, fontSize: number): void {
  const [rx, ry] = svg.point(node.get('rx'), node.get('ry'), fontSize);
  if (!rx || !ry) return;
  const ratioX = rx / Math.sqrt(Math.PI);
  const ratioY = ry / Math.sqrt(Math.PI);
  const [cx, cy] = svg.point(node.get('cx'), node.get('cy'), fontSize);

  svg.stream.moveTo(cx + rx, cy);
  svg.stream.curveTo(cx + rx, cy + ratioY, cx + ratioX, cy + ry, cx, cy + ry);
  svg.stream.curveTo(cx - ratioX, cy + ry, cx - rx, cy + ratioY, cx - rx, cy);
  svg.stream.curveTo(cx - rx, cy - ratioY, cx - ratioX, cy - ry, cx, cy - ry);
  svg.stream.curveTo(cx + ratioX, cy - ry, cx + rx, cy - ratioY, cx + rx, cy);
  svg.stream.close();
}

export function rect(svg: any, node: any, fontSize: number): void {
  const [width, height] = svg.point(node.get('width'), node.get('height'), fontSize);
  if (width <= 0 || height <= 0) return;

  const [x, y] = svg.point(node.get('x'), node.get('y'), fontSize);

  let rxAttr: string | null = node.get('rx') ?? null;
  let ryAttr: string | null = node.get('ry') ?? null;
  if (rxAttr && ryAttr === null) ryAttr = rxAttr;
  else if (ryAttr && rxAttr === null) rxAttr = ryAttr;
  let [rx, ry] = svg.point(rxAttr, ryAttr, fontSize);

  if (rx === 0 || ry === 0) {
    svg.stream.rectangle(x, y, width, height);
    return;
  }

  if (rx > width / 2) rx = width / 2;
  if (ry > height / 2) ry = height / 2;

  // Inspired by Cairo Cookbook
  // https://cairographics.org/cookbook/roundedrectangles/
  const arcToBezier = (4 * (2 ** 0.5 - 1)) / 3;
  const c1 = arcToBezier * rx;
  const c2 = arcToBezier * ry;

  svg.stream.moveTo(x + rx, y);
  svg.stream.lineTo(x + width - rx, y);
  svg.stream.curveTo(x + width - rx + c1, y, x + width, y + c2, x + width, y + ry);
  svg.stream.lineTo(x + width, y + height - ry);
  svg.stream.curveTo(x + width, y + height - ry + c2, x + width + c1 - rx, y + height, x + width - rx, y + height);
  svg.stream.lineTo(x + rx, y + height);
  svg.stream.curveTo(x + rx - c1, y + height, x, y + height - c2, x, y + height - ry);
  svg.stream.lineTo(x, y + ry);
  svg.stream.curveTo(x, y + ry - c2, x + rx - c1, y, x + rx, y);
  svg.stream.close();
}

export function line(svg: any, node: any, fontSize: number): void {
  const [x1, y1] = svg.point(node.get('x1'), node.get('y1'), fontSize);
  const [x2, y2] = svg.point(node.get('x2'), node.get('y2'), fontSize);
  svg.stream.moveTo(x1, y1);
  svg.stream.lineTo(x2, y2);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  node.vertices.push([x1, y1], [Math.PI - angle, angle], [x2, y2]);
}

export function polygon(svg: any, node: any, fontSize: number): void {
  polyline(svg, node, fontSize);
  svg.stream.close();
}

export function polyline(svg: any, node: any, fontSize: number): void {
  let points = normalize(node.get('points'));
  if (points) {
    let [x, y, rest] = point(svg, points, fontSize);
    points = rest;
    svg.stream.moveTo(x, y);
    node.vertices.push([x, y]);
    while (points) {
      const xOld = x;
      const yOld = y;
      [x, y, points] = point(svg, points, fontSize);
      const angle = Math.atan2(x - xOld, y - yOld);
      node.vertices.push([Math.PI - angle, angle]);
      svg.stream.lineTo(x, y);
      node.vertices.push([x, y]);
    }
  }
}
