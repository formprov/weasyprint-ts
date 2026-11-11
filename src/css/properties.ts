// SPDX-License-Identifier: BSD-3-Clause

/** Data about known CSS properties (mirrors weasyprint/css/properties.py). */
import { rgba } from './color.ts';
import type { Color } from './color.ts';

export interface Dimension {
  readonly value: number;
  readonly unit: string | null;
}
export const dim = (value: number, unit: string | null): Dimension => ({ value, unit });
export const ZERO_PIXELS: Dimension = dim(0, 'px');

const black: Color = rgba(0, 0, 0, 1);
const transparent: Color = rgba(0, 0, 0, 0);
const P0 = dim(0, '%');
const P50 = dim(50, '%');
const P100 = dim(100, '%');

// Values are held in the same shapes Python uses: tuples are arrays, keywords
// are strings, lengths are Dimension objects (or numbers once computed).
export const INITIAL_VALUES: Record<string, any> = {
  // CSS 2.1
  bottom: 'auto', caption_side: 'top', clear: 'none', clip: [], color: black,
  direction: 'ltr', display: ['inline', 'flow'], empty_cells: 'show', float: 'none',
  left: 'auto', line_height: 'normal',
  margin_top: ZERO_PIXELS, margin_right: ZERO_PIXELS, margin_bottom: ZERO_PIXELS, margin_left: ZERO_PIXELS,
  padding_top: ZERO_PIXELS, padding_right: ZERO_PIXELS, padding_bottom: ZERO_PIXELS, padding_left: ZERO_PIXELS,
  position: 'static', right: 'auto', table_layout: 'auto', top: 'auto',
  unicode_bidi: 'normal', vertical_align: 'baseline', visibility: 'visible', z_index: 'auto',

  // Backgrounds and Borders 3
  background_attachment: ['scroll'], background_clip: ['border-box'], background_color: transparent,
  background_image: [['none', null]], background_origin: ['padding-box'],
  background_position: [['left', P0, 'top', P0]], background_repeat: [['repeat', 'repeat']],
  background_size: [['auto', 'auto']],
  border_bottom_color: 'currentcolor',
  border_bottom_left_radius: [ZERO_PIXELS, ZERO_PIXELS], border_bottom_right_radius: [ZERO_PIXELS, ZERO_PIXELS],
  border_bottom_style: 'none', border_bottom_width: 3, border_collapse: 'separate',
  border_left_color: 'currentcolor', border_left_style: 'none', border_left_width: 3,
  border_right_color: 'currentcolor', border_right_style: 'none', border_right_width: 3,
  border_spacing: [0, 0],
  border_top_color: 'currentcolor',
  border_top_left_radius: [ZERO_PIXELS, ZERO_PIXELS], border_top_right_radius: [ZERO_PIXELS, ZERO_PIXELS],
  border_top_style: 'none', border_top_width: 3,
  border_image_source: ['none', null],
  border_image_slice: [P100, P100, P100, P100, null],
  border_image_width: [1, 1, 1, 1],
  border_image_outset: [dim(0, null), dim(0, null), dim(0, null), dim(0, null)],
  border_image_repeat: ['stretch', 'stretch'],
  box_shadow: [],
  mask_border_source: ['none', null],
  mask_border_slice: [P100, P100, P100, P100, null],
  mask_border_width: ['auto', 'auto', 'auto', 'auto'],
  mask_border_outset: [dim(0, null), dim(0, null), dim(0, null), dim(0, null)],
  mask_border_repeat: ['stretch', 'stretch'],
  mask_border_mode: 'alpha',

  color_scheme: 'normal',
  opacity: 1,

  column_width: 'auto', column_count: 'auto', column_rule_color: 'currentcolor',
  column_rule_style: 'none', column_rule_width: 'medium', column_fill: 'balance', column_span: 'none',

  font_family: ['serif'], font_feature_settings: 'normal', font_kerning: 'auto',
  font_language_override: 'normal', font_size: 16, font_stretch: 'normal', font_style: 'normal',
  font_variant: 'normal', font_variant_alternates: 'normal', font_variant_caps: 'normal',
  font_variant_east_asian: 'normal', font_variant_ligatures: 'normal', font_variant_numeric: 'normal',
  font_variant_position: 'normal', font_weight: 400,
  font_variation_settings: 'normal',

  box_decoration_break: 'slice', break_after: 'auto', break_before: 'auto', break_inside: 'auto',
  margin_break: 'auto', orphans: 2, widows: 2,

  bookmark_label: [['content', 'text']], bookmark_level: 'none', bookmark_state: 'open',
  content: 'normal', footnote_display: 'block', footnote_policy: 'auto', quotes: 'auto', string_set: 'none',

  image_resolution: 1, image_rendering: 'auto', image_orientation: 'from-image', object_fit: 'fill',
  object_position: [['left', P50, 'top', P50]],

  size: null, page: 'auto', bleed_left: 'auto', bleed_right: 'auto', bleed_top: 'auto', bleed_bottom: 'auto',
  marks: [],

  hyphenate_character: '‐', hyphenate_limit_chars: [5, 2, 2], hyphenate_limit_zone: ZERO_PIXELS,
  hyphens: 'manual', letter_spacing: 'normal', tab_size: 8, text_align_all: 'start',
  text_align_last: 'auto', text_indent: ZERO_PIXELS, text_transform: 'none', white_space: 'normal',
  word_break: 'normal', word_spacing: 0,

  transform_origin: [P50, P50], transform: [],

  appearance: 'none', outline_color: 'currentcolor', outline_style: 'none', outline_width: 3, outline_offset: 0,

  box_sizing: 'content-box', height: 'auto', max_height: dim(Infinity, 'px'), max_width: dim(Infinity, 'px'),
  min_height: 'auto', min_width: 'auto', width: 'auto',

  block_size: 'auto', inline_size: 'auto', max_block_size: dim(Infinity, 'px'),
  max_inline_size: dim(Infinity, 'px'), min_block_size: 'auto', min_inline_size: 'auto',
  margin_block_start: 0, margin_inline_start: 0, margin_block_end: 0, margin_inline_end: 0,
  padding_block_start: 0, padding_inline_start: 0, padding_block_end: 0, padding_inline_end: 0,
  inset_block_start: 'auto', inset_inline_start: 'auto', inset_block_end: 'auto', inset_inline_end: 'auto',
  border_block_start_width: 3, border_inline_start_width: 3, border_block_end_width: 3, border_inline_end_width: 3,
  border_block_start_style: 'none', border_inline_start_style: 'none',
  border_block_end_style: 'none', border_inline_end_style: 'none',
  border_block_start_color: 'currentcolor', border_inline_start_color: 'currentcolor',
  border_block_end_color: 'currentcolor', border_inline_end_color: 'currentcolor',
  border_start_start_radius: 0, border_start_end_radius: 0, border_end_start_radius: 0, border_end_end_radius: 0,

  flex_basis: 'auto', flex_direction: 'row', flex_grow: 0, flex_shrink: 1, flex_wrap: 'nowrap',

  grid_auto_columns: ['auto'], grid_auto_flow: ['row'], grid_auto_rows: ['auto'],
  grid_template_areas: 'none', grid_template_columns: 'none', grid_template_rows: 'none',
  grid_row_start: 'auto', grid_column_start: 'auto', grid_row_end: 'auto', grid_column_end: 'auto',

  align_content: ['normal'], align_items: ['normal'], align_self: ['auto'],
  justify_content: ['normal'], justify_items: ['normal'], justify_self: ['auto'],
  order: 0, column_gap: 'normal', row_gap: 'normal',

  text_decoration_line: 'none', text_decoration_color: 'currentcolor', text_decoration_style: 'solid',
  text_decoration_thickness: 'auto', text_underline_offset: 'auto',

  block_ellipsis: 'none', continue: 'auto', max_lines: 'none', overflow: 'visible',
  overflow_wrap: 'normal', text_overflow: 'clip',

  counter_increment: 'auto', counter_reset: [], counter_set: [],
  list_style_image: ['none', null], list_style_position: 'outside', list_style_type: 'disc',

  anchor: null, lang: null,
};

export const KNOWN_PROPERTIES = new Set(Object.keys(INITIAL_VALUES).map((n) => n.replace(/_/g, '-')));

export const INHERITED = new Set([
  'block_ellipsis', 'border_collapse', 'border_spacing', 'caption_side', 'color', 'color_scheme',
  'direction', 'empty_cells', 'font_family', 'font_feature_settings', 'font_kerning',
  'font_language_override', 'font_size', 'font_style', 'font_stretch', 'font_variant',
  'font_variant_alternates', 'font_variant_caps', 'font_variant_east_asian', 'font_variant_ligatures',
  'font_variant_numeric', 'font_variant_position', 'font_variation_settings', 'font_weight', 'hyphens',
  'hyphenate_character', 'hyphenate_limit_chars', 'hyphenate_limit_zone', 'image_rendering',
  'image_resolution', 'lang', 'letter_spacing', 'line_height', 'list_style_image', 'list_style_position',
  'list_style_type', 'orphans', 'overflow_wrap', 'quotes', 'tab_size', 'text_align_all', 'text_align_last',
  'text_indent', 'text_transform', 'text_underline_offset', 'visibility', 'white_space', 'widows',
  'word_break', 'word_spacing',
]);

export const TABLE_WRAPPER_BOX_PROPERTIES = new Set([
  'bottom', 'break_after', 'break_before', 'clear', 'counter_increment', 'counter_reset', 'counter_set',
  'float', 'left', 'margin_top', 'margin_bottom', 'margin_left', 'margin_right', 'margin_block_start',
  'margin_block_end', 'margin_inline_start', 'margin_inline_end', 'opacity', 'overflow', 'position', 'right',
  'top', 'transform', 'transform_origin', 'vertical_align', 'z_index',
]);

export const INITIAL_NOT_COMPUTED = new Set([
  'display', 'column_gap', 'bleed_top', 'bleed_left', 'bleed_bottom', 'bleed_right', 'outline_width',
  'column_rule_width', 'border_top_width', 'border_left_width', 'border_bottom_width', 'border_right_width',
  'border_block_start_width', 'border_inline_start_width', 'border_block_end_width', 'border_inline_end_width',
]);