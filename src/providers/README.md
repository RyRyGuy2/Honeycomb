# Chat connectors

The presets in `src/shared/chat-presets.ts` use the same HTTP transport for model discovery and text chat. Connection profiles are saved in Electron's user data directory. API keys are encrypted with Electron `safeStorage`.

## Microsoft Copilot for Windows

**Chat only · Windows**

The Windows build compiles a helper using the system .NET Framework compiler. It uses the signed-in desktop app's prompt, send, and completed-reply accessibility controls. For a follow-up, the helper checks that the app is showing the same Copilot conversation before sending. App versions with different controls can use the prompt and reply handoff. [Windows UI Automation overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview)
