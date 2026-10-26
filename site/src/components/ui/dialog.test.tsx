import { expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  withScrollingMiddle,
} from "./dialog"

const CHROME = [DialogHeader, DialogFooter]

type Shaped = React.ReactElement<{ className?: string; children?: React.ReactNode }>

test("a form that holds the footer keeps it pinned and scrolls only its fields", () => {
  const out = React.Children.toArray(
    withScrollingMiddle(
      [
        <DialogHeader key="h" />,
        <form key="f">
          <input />
          <DialogFooter className="mt-4" />
        </form>,
      ],
      CHROME
    )
  ) as Shaped[]

  // The form stays the popup's child, so the footer's edge-to-edge margins sit
  // against the popup and nothing overflows the scrolling part.
  const form = out[1]
  expect(form.type).toBe("form")
  const inner = React.Children.toArray(form.props.children) as Shaped[]
  expect(inner.map((node) => node.type)).toEqual([DialogBody, DialogFooter])
})

test("the scrolling part leaves room for a focused field's ring", () => {
  const out = React.Children.toArray(
    withScrollingMiddle([<DialogHeader key="h" />, <input key="i" />], CHROME)
  ) as Shaped[]
  const body = out[1]
  expect(body.type).toBe(DialogBody)
  expect(body.props.className).not.toContain("px-0")
})

// A control's hit area may reach past the padding, as a switch's does at the
// row's end. The scrolling part scrolls up and down only.
test("the scrolling part never scrolls sideways", () => {
  const out = React.Children.toArray(
    withScrollingMiddle([<DialogHeader key="h" />, <input key="i" />], CHROME)
  ) as Shaped[]
  const html = renderToStaticMarkup(out[1])
  expect(html).toContain("overflow-x-hidden")
})
