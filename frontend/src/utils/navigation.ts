import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

// Use Excalidraw's element query parameter, with a relative URL so archived
// scenes work through either a hostname or an IP address.
export const createElementLink = (id: string): string =>
  `${window.location.pathname}?element=${encodeURIComponent(id)}`

export const getElementLinkTarget = (link: string): string | null => {
  try {
    const current = new URL(window.location.href)
    const target = new URL(link, current)
    if (target.origin !== current.origin || target.pathname !== current.pathname) return null
    return target.searchParams.get('element') || null
  } catch {
    return null
  }
}

export const findLinkTargetElements = (
  elements: readonly ExcalidrawElement[],
  id: string
): ExcalidrawElement[] => {
  const element = elements.find(item => item.id === id && !item.isDeleted)
  if (element) return [element]
  return elements.filter(item => !item.isDeleted && item.groupIds.includes(id))
}
