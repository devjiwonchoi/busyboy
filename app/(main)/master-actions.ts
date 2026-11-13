'use server'

import { dataFolder } from '@/server/config'
import { sendToMaster } from '@/server/master-chat'
import { busyboyMcpServer } from '@/server/mcp-tools'
import { defaultProvider } from '@/server/providers'

export async function sendToMasterAction(text: string) {
  await sendToMaster({
    folder: await dataFolder(),
    text,
    provider: await defaultProvider(),
    mcp: await busyboyMcpServer(),
  })
}
