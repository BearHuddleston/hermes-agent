// Shared chats (Webapp): presence, turn ownership and per-chat sharing; `Translations` extends this.
export interface SharedChatTranslations {
  presence: {
    you: string
    typingOne: (name: string) => string
    typingTwo: (first: string, second: string) => string
    typingMany: (count: number) => string
    windows: (count: number) => string
    renameTitle: string
    renamePlaceholder: string
    renameHint: string
    renameSave: string
    /** Shared chats: another person holds the running turn (tui_gateway/shared_turns.py). The
     * composer shows it on one clipped line: keep it short and the name first. */
    turnRunning: (name: string) => string
    waitingFor: (name: string) => string
    /** Stand-in name for the chat's creator when they are not in the room. */
    chatCreator: string
    /** A touch reader's marker at the message they are reading. */
    viewingHere: (name: string) => string
  }

  /** Sharing a chat with other people signed in to this agent (hermes_cli/web_sharing.py). */
  sharing: {
    share: string
    title: string
    description: string
    claimTitle: string
    claimBody: string
    claim: string
    claimFailed: string
    yourId: string
    yourIdHint: string
    copy: string
    copied: string
    addPerson: string
    addPlaceholder: string
    add: string
    signedInRecently: string
    nobodyYet: string
    sharedWith: string
    notShared: string
    roleViewer: string
    roleParticipant: string
    roleOwner: string
    remove: string
    changeFailed: string
    viewerComposer: string
    viewerNote: string
    accessRemoved: string
  }
}
