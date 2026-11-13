import { expect, test, type APIRequestContext } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

/** Sends one JSON-RPC message to busyboy's MCP endpoint, with this context's data folder cookie. */
async function rpc(request: APIRequestContext, method: string, params: Record<string, unknown> = {}) {
  const response = await request.post('/api/mcp', { data: { jsonrpc: '2.0', id: 1, method, params } })
  expect(response.status()).toBe(200)
  return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } }
}

test('calling list_projects should return the projects', async ({ context, baseURL }) => {
  const { projects } = await useProjectsHome(context, baseURL!, ['web', 'api'])

  const initialize = await rpc(context.request, 'initialize', { protocolVersion: '2025-06-18' })
  expect(initialize.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'busyboy' } })
  const list = await rpc(context.request, 'tools/list')
  expect((list.result?.tools as { name: string }[]).map(({ name }) => name)).toContain('list_projects')

  const call = await rpc(context.request, 'tools/call', { name: 'list_projects', arguments: {} })

  const text = (call.result?.content as { text: string }[])[0].text
  expect(JSON.parse(text)).toEqual([
    { name: 'web', path: projects.web },
    { name: 'api', path: projects.api },
  ])
})

test('calling an unknown tool should return an error', async ({ context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'])

  const call = await rpc(context.request, 'tools/call', { name: 'delete_everything', arguments: {} })

  expect(call.error).toEqual({ code: -32602, message: 'Unknown tool: delete_everything' })
})
