// SPDX-License-Identifier: BSD-3-Clause

/** Manage background position and size (mirrors layout/background.py). */
import { rgba } from '../css/color.ts';
import { getColor } from '../draw/color.ts';
import * as boxes from '../formatting_structure/boxes.ts';
import { LOGGER } from '../logger.ts';
import { percentage, resolveRadiiPercentages } from './percent.ts';
import * as replaced from './replaced.ts';

type AnyBox = any;

export interface BackgroundLayer {
  image: any;
  size: any;
  position: any;
  repeat: any;
  unbounded: boolean;
  paintingArea: any;
  positioningArea: any;
  clippedBoxes: any[];
}
export interface Background {
  color: any;
  layers: BackgroundLayer[];
  style: any;
}

export function boxRectangle(box: AnyBox, whichRectangle: string): [number, number, number, number] {
  if (whichRectangle === 'border-box') return [box.borderBoxX(), box.borderBoxY(), box.borderWidth(), box.borderHeight()];
  if (whichRectangle === 'padding-box') return [box.paddingBoxX(), box.paddingBoxY(), box.paddingWidth(), box.paddingHeight()];
  if (whichRectangle !== 'content-box') throw new Error(`unknown rectangle ${whichRectangle}`);
  return [box.contentBoxX(), box.contentBoxY(), box.width, box.height];
}

/** Fetch and position background images. */
export function layoutBoxBackgrounds(page: AnyBox, box: AnyBox, getImageFromUri: (o: any) => any, layoutChildren = true, style: any = null): void {
  // Resolve percentages in border-radius properties.
  resolveRadiiPercentages(box);

  if (layoutChildren) for (const child of box.allChildren()) layoutBoxBackgrounds(page, child, getImageFromUri);

  if (style === null) style = box.style;

  // This is for the border image, not the background, but this is a convenient place to get the image.
  if (style.get('border_image_source')[0] !== 'none') {
    const [type, value] = style.get('border_image_source');
    box.borderImage = type === 'url' ? getImageFromUri({ url: value }) : value;
  }
  if (style.get('mask_border_source')[0] !== 'none') {
    const [type, value] = style.get('mask_border_source');
    box.maskBorderImage = type === 'url' ? getImageFromUri({ url: value }) : value;
  }

  let images: any[];
  let color: any;
  if (style.get('visibility') === 'hidden') {
    images = [];
    color = rgba(0, 0, 0, 0);
  } else {
    const orientation = style.get('image_orientation');
    images = style.get('background_image').map(([type, value]: [string, any]) =>
      type === 'url' ? getImageFromUri({ url: value, orientation }) : value);
    color = getColor(style, 'background_color');
  }

  if (color.a === 0 && !images.some(Boolean) && !style.get('box_shadow').length) {
    if (box !== page) {
      // Pages need a background for bleed box.
      box.background = null;
      return;
    }
  }

  const cyc = (list: any[], i: number): any => list[i % list.length];
  const layers = images.map((image, i) =>
    layoutBackgroundLayer(
      box, page, style.get('image_resolution'), image, cyc(style.get('background_size'), i), cyc(style.get('background_clip'), i),
      cyc(style.get('background_repeat'), i), cyc(style.get('background_origin'), i), cyc(style.get('background_position'), i),
      cyc(style.get('background_attachment'), i)));
  box.background = { color, layers, style } as Background;
}

export function layoutBackgroundLayer(
  box: AnyBox, page: AnyBox, resolution: number, image: any, size: any, clip: string, repeat: [string, string], origin: string,
  position: any[], attachment: string,
): BackgroundLayer {
  // TODO: respect box-sizing for table cells?
  let clippedBoxes: any[] = [];
  let paintingArea: any = [0, 0, 0, 0];
  if (box === page) {
    // [The page's] background painting area is the bleed area […] regardless of background-clip.
    // https://drafts.csswg.org/css-page-3/#painting
    paintingArea = page.bleedArea;
    clippedBoxes = [];
  } else if (box instanceof boxes.TableRowGroupBox) {
    clippedBoxes = [];
    let totalHeight = 0;
    for (const row of box.children) {
      if (row.children.length) {
        clippedBoxes.push(...row.children.map((cell: AnyBox) => cell.roundedBorderBox()));
        totalHeight = Math.max(totalHeight, Math.max(...row.children.map((cell: AnyBox) => cell.borderHeight())));
      }
    }
    paintingArea = [box.borderBoxX(), box.borderBoxY(), box.borderWidth(), totalHeight];
  } else if (box instanceof boxes.TableRowBox) {
    if (box.children.length) {
      clippedBoxes = box.children.map((cell: AnyBox) => cell.roundedBorderBox());
      const height = Math.max(...box.children.map((cell: AnyBox) => cell.borderHeight()));
      paintingArea = [box.borderBoxX(), box.borderBoxY(), box.borderWidth(), height];
    }
  } else if (box instanceof boxes.TableColumnGroupBox || box instanceof boxes.TableColumnBox) {
    const cells = box.getCells();
    if (cells.length) {
      clippedBoxes = cells.map((cell: AnyBox) => cell.roundedBorderBox());
      const minX = Math.min(...cells.map((cell: AnyBox) => cell.borderBoxX()));
      const maxX = Math.max(...cells.map((cell: AnyBox) => cell.borderBoxX() + cell.borderWidth()));
      paintingArea = [minX, box.borderBoxY(), maxX - minX, box.borderHeight()];
    }
  } else {
    paintingArea = boxRectangle(box, clip);
    if (clip === 'border-box') clippedBoxes = [box.roundedBorderBox()];
    else if (clip === 'padding-box') clippedBoxes = [box.roundedPaddingBox()];
    else clippedBoxes = [box.roundedContentBox()];
  }

  let intrinsicWidth = 0;
  let intrinsicHeight = 0;
  let ratio: number | null = null;
  if (image !== null && image !== undefined) [intrinsicWidth, intrinsicHeight, ratio] = image.getIntrinsicSize(resolution, box.style.get('font_size'));
  if (image === null || image === undefined || intrinsicWidth === 0 || intrinsicHeight === 0) {
    return {
      image: null, unbounded: false, paintingArea, size: 'unused', position: 'unused', repeat: 'unused', positioningArea: 'unused', clippedBoxes,
    };
  }

  let positioningArea: any;
  if (attachment === 'fixed') {
    // Initial containing block
    if (box instanceof boxes.PageBox) {
      // […] if background-attachment is fixed then the image is positioned relative to the page box
      // including its margins […]. https://drafts.csswg.org/css-page/#painting
      positioningArea = [0, 0, box.marginWidth(), box.marginHeight()];
    } else positioningArea = boxRectangle(page, 'content-box');
  } else positioningArea = boxRectangle(box, origin);

  const [, , positioningWidth, positioningHeight] = positioningArea;

  let imageWidth: number;
  let imageHeight: number;
  if (size === 'cover') [imageWidth, imageHeight] = replaced.coverConstraintImageSizing(positioningWidth, positioningHeight, ratio);
  else if (size === 'contain') [imageWidth, imageHeight] = replaced.containConstraintImageSizing(positioningWidth, positioningHeight, ratio);
  else {
    const [sizeWidth, sizeHeight] = size;
    [imageWidth, imageHeight] = replaced.defaultImageSizing(
      intrinsicWidth, intrinsicHeight, ratio, percentage(sizeWidth, box.style, positioningWidth),
      percentage(sizeHeight, box.style, positioningHeight), positioningWidth, positioningHeight);
  }

  const [originX, , originY] = position;
  let [, positionX, , positionY] = position;
  const refX = positioningWidth - imageWidth;
  const refY = positioningHeight - imageHeight;
  positionX = percentage(positionX, box.style, refX);
  positionY = percentage(positionY, box.style, refY);
  if (originX === 'right') positionX = refX - positionX;
  if (originY === 'bottom') positionY = refY - positionY;

  const [repeatX, repeatY] = repeat;
  const pyRound = (x: number): number => {
    // Python's round(): half to even.
    const f = Math.floor(x);
    const d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  };

  if (repeatX === 'round') {
    const nRepeats = Math.max(1, pyRound(positioningWidth / imageWidth));
    const newWidth = positioningWidth / nRepeats;
    positionX = 0; // Ignore background-position for this dimension.
    if (repeatY !== 'round' && size[1] === 'auto') imageHeight *= newWidth / imageWidth;
    imageWidth = newWidth;
  }
  if (repeatY === 'round') {
    const nRepeats = Math.max(1, pyRound(positioningHeight / imageHeight));
    const newHeight = positioningHeight / nRepeats;
    positionY = 0; // Ignore background-position for this dimension.
    if (repeatX !== 'round' && size[0] === 'auto') imageWidth *= newHeight / imageHeight;
    imageHeight = newHeight;
  }

  return {
    image, size: [imageWidth, imageHeight], position: [positionX, positionY], repeat, unbounded: false, paintingArea, positioningArea, clippedBoxes,
  };
}

/**
 * Layout backgrounds on the page box and on its children. Takes care of the canvas background,
 * taken from the root element or a <body> child of the root element
 * (https://www.w3.org/TR/CSS21/colors.html#background).
 */
export function layoutBackgrounds(page: AnyBox, getImageFromUri: (o: any) => any): void {
  layoutBoxBackgrounds(page, page, getImageFromUri);
  if (page.children[0] instanceof boxes.MarginBox) throw new Error('unexpected margin box');
  const rootBox = page.children[0];
  let chosenBox = rootBox;
  if (rootBox.elementTag.toLowerCase() === 'html' && rootBox.background === null) {
    for (const child of rootBox.children) {
      if (child.elementTag.toLowerCase() === 'body') {
        chosenBox = child;
        break;
      }
    }
  }

  if (chosenBox.background) {
    const paintingArea = boxRectangle(page, 'border-box');
    const originalBackground = page.background;
    layoutBoxBackgrounds(page, page, getImageFromUri, false, chosenBox.style);
    page.canvasBackground = {
      ...page.background,
      // TODO: background-clip should be updated
      layers: page.background.layers.map((layer: BackgroundLayer) => ({ ...layer, paintingArea })),
    };
    page.background = originalBackground;
    chosenBox.background = null;
  } else page.canvasBackground = null;
}