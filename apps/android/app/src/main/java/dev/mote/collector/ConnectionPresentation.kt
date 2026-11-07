package dev.mote.collector

/** P05/P06 connection-page copy aligned with iOS ConnectionView. */
internal object ConnectionPresentation {
    val invalidInvitation get() = MoteI18n.text("邀请已失效")
    val connecting get() = MoteI18n.text("正在连接…")
    val incomplete get() = MoteI18n.text("连接未完成")
    val retry get() = MoteI18n.text("重试")
    val selfDevice get() = MoteI18n.text("本人设备")
    val pendingSend get() = MoteI18n.text("连接后发送")
    val confirm get() = MoteI18n.text("确认连接")
    val scanQr get() = MoteI18n.text("扫描二维码")

    fun pendingCountLabel(count: Int?) =
        count?.let { MoteI18n.text("{0} 条记录", it) } ?: MoteI18n.text("暂时无法读取")

    fun isInvalidInvitation(category: String) = category in setOf("invitation", "expired", "invite_rejected")

    enum class Surface { START_INVALID, REVIEW_INCOMPLETE, REVIEW_DETAIL }

    fun surface(category: String) = when {
        isInvalidInvitation(category) -> Surface.START_INVALID
        category in setOf(
            "storage", "no_pending", "device_conflict", "local_confirmation", "pending", "busy",
        ) -> Surface.REVIEW_DETAIL
        else -> Surface.REVIEW_INCOMPLETE
    }

    fun message(code: String) = when (code) {
        "storage" -> MoteI18n.text("凭据持久保存失败，恢复记录仍保留。请释放空间后恢复连接，不要卸载应用。")
        "no_pending" -> MoteI18n.text("没有可恢复的兑换结果，请重新生成邀请。")
        "unchecked" -> MoteI18n.text("尚未测试连接")
        "connected" -> MoteI18n.text("上次连接测试成功（不是持续在线保证）")
        "invitation", "expired", "invite_rejected" -> invalidInvitation
        "device_conflict" -> MoteI18n.text("中央已有此设备 ID。请用上方设备 ID 生成绑定邀请，再试一次；不会更换设备身份。")
        "local_confirmation" -> MoteI18n.text("本机有尚未绑定节点的资料，请确认档案地址后再连接。")
        "pending" -> MoteI18n.text("仍有截图/笔记/来源待同步或已准备提交的草稿，不能切换节点。请先同步原节点。")
        "busy" -> MoteI18n.text("另一次设置操作尚未完成，请稍候再试。")
        "authentication" -> MoteI18n.text("节点拒绝当前凭据，请生成绑定本设备的邀请。")
        "protocol_incompatible" -> centralFailureMessage(426, "incompatible_protocol")
        "origin_denied" -> centralFailureMessage(403, "origin_denied")
        "permission" -> centralFailureMessage(403, "connection_scope_denied")
        "not_found" -> centralFailureMessage(404, "")
        "identity", "response" -> MoteI18n.text("节点响应或设备身份校验失败，未确认连接；旧配置保留。")
        "rate_limit" -> MoteI18n.text("节点暂时限流，稍后重试。")
        "network" -> MoteI18n.text("节点连接失败，请检查地址、网络与 TLS 证书后重试。")
        else -> incomplete
    }

    fun visibleNotice(category: String) = when (surface(category)) {
        Surface.START_INVALID -> invalidInvitation
        Surface.REVIEW_INCOMPLETE -> incomplete
        Surface.REVIEW_DETAIL -> message(category)
    }
}
