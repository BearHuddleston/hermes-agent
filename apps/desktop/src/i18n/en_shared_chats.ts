import type { SharedChatTranslations } from './types_shared_chats'

// Shared chats (Webapp): presence, turn ownership and per-chat sharing, spread into en.ts.
export const enSharedChats: SharedChatTranslations = {
  presence: {
    you: 'you',
    typingOne: name => `${name} is typing`,
    typingTwo: (first, second) => `${first} and ${second} are typing`,
    typingMany: count => `${count} people are typing`,
    windows: count => `${count} windows`,
    renameTitle: 'Your name in this chat',
    renamePlaceholder: 'Name others see',
    renameHint:
      'Shown beside your pointer and on your avatar. Your sign-in decides who you are; this is only the label.',
    renameSave: 'Save',
    turnRunning: name => `${name}'s turn · your messages wait`,
    waitingFor: name => `Waiting for ${name} to answer`,
    chatCreator: "the chat's creator",
    viewingHere: name => `${name} is reading here`
  },
  sharing: {
    share: 'Share',
    title: 'Share this chat',
    description:
      'People you add see this chat and its apps live. Viewers follow along; participants can also send messages.',
    claimTitle: 'Make this agent yours first',
    claimBody:
      'Anyone your Portal lets sign in can currently see every chat here. Claim the agent and everyone else sees only the chats you share with them.',
    claim: 'Claim this agent',
    claimFailed: 'Could not claim this agent',
    yourId: 'Your account ID',
    yourIdHint: 'Send this to a chat owner so they can add you.',
    copy: 'Copy',
    copied: 'Copied',
    addPerson: 'Add a person',
    addPlaceholder: 'Account ID, e.g. nous:usr_1a2b',
    add: 'Add',
    signedInRecently: 'Signed in to this agent',
    nobodyYet: 'Nobody else has signed in yet. Once someone does, they appear here.',
    sharedWith: 'Shared with',
    notShared: 'Only you can see this chat.',
    roleViewer: 'Viewer',
    roleParticipant: 'Participant',
    roleOwner: 'Owner',
    remove: 'Remove',
    changeFailed: 'Could not change who this chat is shared with',
    viewerComposer: 'View only. Ask to be a participant.',
    viewerNote: 'View only',
    accessRemoved: 'No longer shared with you.'
  }
}
