interface MdastNode {
  type: string
  children?: MdastNode[]
  value?: string
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/

const walk = (node: MdastNode): void => {
  if (node.type === 'blockquote') {
    const first = node.children?.[0]
    if (first?.type === 'paragraph') {
      const textNode = first.children?.[0]
      if (textNode?.type === 'text' && typeof textNode.value === 'string') {
        const match = textNode.value.match(ALERT_RE)
        const type = match?.[1]
        if (match && type) {
          textNode.value = textNode.value.slice(match[0].length)
          if (!textNode.value) first.children?.shift()
          node.data = node.data ?? {}
          node.data.hName = 'div'
          node.data.hProperties = {
            className: `md-alert md-alert-${type.toLowerCase()}`,
          }
        }
      }
    }
  }
  node.children?.forEach(walk)
}

export const remarkAlerts = () => (tree: MdastNode) => {
  walk(tree)
}
