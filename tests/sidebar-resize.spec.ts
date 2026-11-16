import { expect, test } from '@playwright/test'

test('dragging the sidebar edge should resize it and keep the width after a reload', async ({ page }) => {
  await page.goto('/')
  // The landmark is the sidebar's fixed container, so its box is the sidebar's width.
  const container = page.getByRole('complementary', { name: 'Sidebar' })
  const sidebar = container
  const rail = sidebar.getByRole('button', { name: 'Resize Sidebar' })
  await expect(container).toBeInViewport()
  const before = (await container.boundingBox())!.width

  // The sidebar is on the right, so dragging its left edge leftward widens it.
  const box = (await rail.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 })
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()

  await expect.poll(async () => (await container.boundingBox())!.width).toBeCloseTo(before + 120, -1)
  // The click that ends the drag must not close the sidebar.
  await expect(sidebar).toHaveJSProperty('inert', false)
  const resized = (await container.boundingBox())!.width

  await page.reload()
  await expect.poll(async () => (await container.boundingBox())!.width).toBeCloseTo(resized, 0)

  // Dragging far past the limit stops at the narrowest width.
  const edge = (await rail.boundingBox())!
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge.x + 2000, edge.y + edge.height / 2, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await container.boundingBox())!.width).toBe(256)
})

test('dragging the sidebar edge past its limits should stop, and a click should still close it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  const rail = sidebar.getByRole('button', { name: 'Resize Sidebar' })
  await expect(sidebar).toBeInViewport()

  const box = (await rail.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 2000, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  // 720 pixels at most, below 60% of this window.
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(720)

  // A narrower window lowers the limit to 60% of its width.
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(600)
  // A wider window lets the dragged width come back.
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(720)

  await rail.click()
  await expect(sidebar).toHaveJSProperty('inert', true)
})

test('resizing the window before any drag should keep the default sidebar width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  await expect(sidebar).toBeInViewport()
  const initial = (await sidebar.boundingBox())!.width

  // Any window resize used to read the default `20rem` as 20 pixels and shrink the sidebar to 256.
  await page.setViewportSize({ width: 1200, height: 900 })
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(initial)
  // The narrowest desktop window still leaves room for the default width.
  await page.setViewportSize({ width: 800, height: 900 })
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(initial)
  expect(initial).toBe(320)
})
