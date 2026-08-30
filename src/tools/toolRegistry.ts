import { ToolManager } from './ToolManager';
import { openWebsiteTool } from './tools/openWebsite';
import { searchWebTool } from './tools/searchWeb';
import { setAtmosphericPaletteTool } from './tools/paletteTools';
import { rememberInformationTool, recallInformationTool, forgetInformationTool } from './tools/memoryTools';
import { openApplicationTool } from './tools/openApplication';
import { ActionManager } from '../actions/ActionManager';
import { ApplicationExecutor } from '../actions/ApplicationExecutor';
import { InputExecutor } from '../actions/InputExecutor';
import { ScreenExecutor } from '../actions/ScreenExecutor';
import { RobotJsInputController, RobotJsScreenController } from '../actions/WindowsProviders';
import { computerInputTool, screenControlTool, listDisplaysTool } from './tools/computerControlTools';
import { closeWindowTool, computerControlAuthorizationTool, focusWindowTool, getActiveWindowTool, listWindowsTool, windowStateTool } from './tools/windowTools';
import { WindowExecutor } from '../actions/WindowExecutor';
import { WindowsWindowProvider } from '../actions/WindowExecutor';
import { ScreenUnderstanding } from '../vision/ScreenUnderstanding';
import { TesseractOcrProvider } from '../vision/TesseractOcrProvider';
import { VisionExecutor } from '../vision/VisionExecutor';
import { inspectScreenTool, locateElementTool } from './tools/visionTools';
import { BrowserExecutor } from '../actions/BrowserExecutor';
import { BrowserSessionManager } from '../browser/BrowserSessionManager';
import { browserOpenTool, browserNavigateTool, browserReadTool, browserTabsTool, browserNewTabTool, browserSwitchTabTool, browserCloseTabTool } from './tools/browserTools';
import { ClipboardExecutor } from '../actions/ClipboardExecutor';
import { getClipboardTool, setClipboardTool, pasteClipboardTool } from './tools/clipboardTools';
import { saveClipboardTool, restoreClipboardTool } from './tools/clipboardRestoreTools';
import { ScreenshotExecutor } from '../actions/ScreenshotExecutor';
import { captureScreenshotTool, captureWindowScreenshotTool } from './tools/screenshotTools';
import { sendWhatsAppMessageTool } from './tools/whatsappTools';
import { closeApplicationTool } from './tools/applicationControlTools';
import { runSystemDiagnosticsTool, repairSystemIssueTool } from './tools/systemDiagnosticsTools';

/**
 * v1.6.10 — the ONE screen controller shared by every executor AND the
 * live screen-share feed. Exported so server.ts can (a) pull fresh frames
 * for the Discord-style live feed and (b) honor user-initiated stop.
 */
export const defaultScreenController = new RobotJsScreenController();

export const defaultBrowserSessionManager = new BrowserSessionManager({ launch: true });

/**
 * Creates and initializes the default ToolManager for Sera
 */
export function createDefaultToolManager(): ToolManager {
  const actionManager = new ActionManager();
  const windowProvider = new WindowsWindowProvider();
  // Inject the window provider into ApplicationExecutor so launched apps
  // are automatically brought to the foreground. Without this, calculator
  // opens behind the SERA Electron window and keyboard input never lands.
  actionManager.registerExecutor(new ApplicationExecutor(
    undefined, // default catalog (now expanded with Paint/Word/Settings/etc.)
    undefined, // default launcher (now cmd.exe-aware for `start` aliases)
    undefined, // platform
    undefined, // readiness checker
    undefined, // process controller
    windowProvider,
  ));
  // v1.6.10: exported as `defaultScreenController` below so the live
  // screen-share feed (server.ts) captures frames through the SAME
  // controller instance the tools use — one shared latest-frame cache,
  // one sharing state.
  const screenProvider = defaultScreenController;
  const ocrProvider = new TesseractOcrProvider();
  const screenUnderstanding = new ScreenUnderstanding(screenProvider, windowProvider, ocrProvider);
  const browserSessionManager = defaultBrowserSessionManager;
  actionManager.registerExecutor(new InputExecutor(new RobotJsInputController(), undefined, undefined, windowProvider));
  actionManager.registerExecutor(new ScreenExecutor(screenProvider));
  actionManager.registerExecutor(new ScreenshotExecutor(screenProvider, windowProvider));
  actionManager.registerExecutor(new WindowExecutor(windowProvider));
  actionManager.registerExecutor(new VisionExecutor(screenUnderstanding));
  actionManager.registerExecutor(new BrowserExecutor(browserSessionManager));
  actionManager.registerExecutor(new ClipboardExecutor());
  const manager = new ToolManager(actionManager);
  // Register default safe automatic tools
  manager.registerTool(openWebsiteTool);
  manager.registerTool(searchWebTool);
  manager.registerTool(setAtmosphericPaletteTool);
  manager.registerTool(rememberInformationTool);
  manager.registerTool(recallInformationTool);
  manager.registerTool(forgetInformationTool);
  manager.registerTool(openApplicationTool);
  manager.registerTool(computerInputTool);
  manager.registerTool(screenControlTool);
  manager.registerTool(listDisplaysTool);
  manager.registerTool(computerControlAuthorizationTool);
  manager.registerTool(getActiveWindowTool);
  manager.registerTool(listWindowsTool);
  manager.registerTool(focusWindowTool);
  manager.registerTool(windowStateTool);
  manager.registerTool(closeWindowTool);
  manager.registerTool(inspectScreenTool);
  manager.registerTool(locateElementTool);
  manager.registerTool(browserOpenTool);
  manager.registerTool(browserNavigateTool);
  manager.registerTool(browserReadTool);
  manager.registerTool(browserTabsTool);
  manager.registerTool(browserNewTabTool);
  manager.registerTool(browserSwitchTabTool);
  manager.registerTool(browserCloseTabTool);
  manager.registerTool(getClipboardTool);
  manager.registerTool(setClipboardTool);
  manager.registerTool(pasteClipboardTool);
  manager.registerTool(saveClipboardTool);
  manager.registerTool(restoreClipboardTool);
  manager.registerTool(captureScreenshotTool);
  manager.registerTool(captureWindowScreenshotTool);
  manager.registerTool(sendWhatsAppMessageTool);
  manager.registerTool(closeApplicationTool);
  manager.registerTool(runSystemDiagnosticsTool);
  manager.registerTool(repairSystemIssueTool);
  return manager;
}

export const defaultToolManager = createDefaultToolManager();






