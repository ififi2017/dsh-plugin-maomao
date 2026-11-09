// A host event in the ordinary chat session, never the user's pairing command.
export function pairingGreeting({ group = false, owner = false } = {}) {
  return '[宿主事件：此聊天刚刚完成配对授权，这不是用户发言。]\n'
    + `请沿用当前选定的人设、语言和语气，向${group ? '群里的大家' : '对方'}自然地打一句招呼，开启聊天。`
    + (owner ? '此私聊已绑定主人，可以自然使用人设里的称呼。' : '聊天授权不等于主人认证，不要擅自称对方为主人。')
    + '只输出一句简短招呼，放在一条纯文字消息里；不要解释配对流程、提及内部事件、展示标识或调用工具。'
    + '不要编造对方的经历或旧记忆。你这句招呼会保留在本会话中，之后可以自然接着聊。';
}
