import { createCn } from 'cn/config';
import { createTV } from 'tailwind-variants';

/** The type-scale tokens in src/app.css; listed so merging treats `text-body` as a size, not a color. */
export const TEXT_SIZES = ['body', 'ui', 'meta', 'tab', 'code'];

const merge = { extend: { classGroups: { 'font-size': [{ text: TEXT_SIZES }] } } };

export const cn = createCn(merge);
/** shadcn's `tv`, with the same merge rules as `cn`. */
export const tv = createTV({ twMergeConfig: merge });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
