import * as React from "react";
import { createRoot } from "react-dom/client";

import { WeixinSettingsTab } from "./dsh-im/channels/weixin/index.js";
import { FeishuSettingsTab } from "./dsh-im/channels/feishu/index.js";
import { installWeixinStyles } from "./dsh-im/channels/weixin/styles.js";
import { installFeishuStyles } from "./dsh-im/channels/feishu/styles.js";
import { installImStyles } from "./dsh-im/styles.js";
import { setImTranslator, h } from "./dsh-im/i18n.js";
import { WorkspaceDirectoryPickerContext } from "./dsh-im/workspace-editor.js";
import { WeixinLogoGlyph, FeishuLogoGlyph } from "./dsh-im/channel-logos.js";
import { weixinRpcCall, feishuRpcCall } from "./rpc.js";

// dsh-im renders bilingual strings via h(); we keep Chinese verbatim (no-op translator).
setImTranslator((key) => key);
installImStyles();
installWeixinStyles();
installFeishuStyles();

const CHANNELS = [
  { id: "weixin", label: "微信", Glyph: WeixinLogoGlyph },
  { id: "feishu", label: "飞书", Glyph: FeishuLogoGlyph },
];

function App() {
  const [selected, setSelected] = React.useState("weixin");

  return h(
    WorkspaceDirectoryPickerContext.Provider,
    { value: null },
    h(
      "section",
      { className: "dim-page", "aria-label": "IM 机器人设置" },
      h(
        "div",
        { className: "dim-layout" },
        h(
          "nav",
          { className: "dim-rail", role: "tablist", "aria-label": "IM 渠道" },
          CHANNELS.map((channel) =>
            h(
              "button",
              {
                key: channel.id,
                type: "button",
                role: "tab",
                id: `dim-tab-${channel.id}`,
                className: "dim-channel",
                "aria-selected": channel.id === selected,
                "aria-controls": `dim-panel-${channel.id}`,
                onClick: () => setSelected(channel.id),
              },
              h(
                "span",
                { className: `dim-logo dim-logo${channel.id === "weixin" ? "Weixin" : "Feishu"}`, "aria-hidden": "true" },
                h(channel.Glyph),
              ),
              h(
                "span",
                { className: "dim-channelCopy" },
                h("strong", null, channel.label),
              ),
            ),
          ),
        ),
      ),
      h("div", { className: "dim-divider", "aria-hidden": "true" }),
      h(
        "main",
        {
          className: "dim-panel",
          role: "tabpanel",
          id: `dim-panel-${selected}`,
          "aria-labelledby": `dim-tab-${selected}`,
        },
        selected === "weixin"
          ? h(WeixinSettingsTab, { rpcCall: weixinRpcCall })
          : h(FeishuSettingsTab, { rpcCall: feishuRpcCall }),
      ),
    ),
  );
}

const root = createRoot(document.getElementById("root"));
root.render(h(App));
