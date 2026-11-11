// SPDX-License-Identifier: BSD-3-Clause

/** Transformation matrix (mirrors weasyprint/matrix.py). */
export class Matrix {
  m: number[][];

  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0, matrix: number[][] | null = null) {
    this.m = matrix ?? [[a, b, 0], [c, d, 0], [e, f, 1]];
  }

  static fromRows(matrix: number[][]): Matrix {
    return new Matrix(1, 0, 0, 1, 0, 0, matrix);
  }

  /** Python's `self @ other`. */
  matmul(other: Matrix): Matrix {
    const a = this.m;
    const b = other.m;
    return Matrix.fromRows(a.map((_, i) => [0, 1, 2].map((j) => {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[i][k] * b[k][j];
      return sum;
    })));
  }

  get determinant(): number {
    const s = this.m;
    return (
      s[0][0] * (s[1][1] * s[2][2] - s[1][2] * s[2][1]) -
      s[1][0] * (s[0][1] * s[2][2] - s[0][2] * s[2][1]) +
      s[2][0] * (s[0][1] * s[1][2] - s[0][2] * s[1][1]));
  }

  get invert(): Matrix {
    const d = this.determinant;
    const s = this.m;
    return Matrix.fromRows([
      [
        (s[1][1] * s[2][2] - s[1][2] * s[2][1]) / d,
        (s[0][1] * s[2][2] - s[0][2] * s[2][1]) / -d,
        (s[0][1] * s[1][2] - s[0][2] * s[1][1]) / d,
      ],
      [
        (s[1][0] * s[2][2] - s[1][2] * s[2][0]) / -d,
        (s[0][0] * s[2][2] - s[0][2] * s[2][0]) / d,
        (s[0][0] * s[1][2] - s[0][2] * s[1][0]) / -d,
      ],
      [
        (s[1][0] * s[2][1] - s[1][1] * s[2][0]) / d,
        (s[0][0] * s[2][1] - s[0][1] * s[2][0]) / -d,
        (s[0][0] * s[1][1] - s[0][1] * s[1][0]) / d,
      ],
    ]);
  }

  transformPoint(x: number, y: number): [number, number] {
    const r = Matrix.fromRows([[x, y, 1]]).matmul(this);
    return [r.m[0][0], r.m[0][1]];
  }

  get values(): [number, number, number, number, number, number] {
    const [[a, b], [c, d], [e, f]] = this.m.map((row) => row.slice(0, 2));
    return [a, b, c, d, e, f];
  }
}