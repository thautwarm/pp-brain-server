export const Format = {
    asrToAgentReply(recognized: string) {
        if (recognized.includes("\n") || recognized.includes("\r")) {
            return "<asr-recognized-text>\n" + recognized.trim() + "\n</asr-recognized-text>"
        }
        return "<asr-recognized-text>" + recognized + "</asr-recognized-text>"
    },


    claimAgentResponse(response: string) {
        if (response.includes("\n") || response.includes("\r")) {
            return "<agent-response>\n" + response.trim() + "\n</agent-response>"
        }
        return "<agent-response>" + response + "</agent-response>"
    },

    warning(message: string) {
        if (message.includes("\n") || message.includes("\r")) {
            return "<asr-warning>\n" + message.trim() + "\n</asr-warning>"
        }
        return "<asr-warning>" + message + "</asr-warning>"
    },

    systemNotification(message: string) {
        if (message.includes("\n") || message.includes("\r")) {
            return "<system-notification>\n" + message.trim() + "\n</system-notification>"
        }
        return "<system-notification>" + message + "</system-notification>"
    },

    /**
     * 人类**没听到**的那段：打断时 agent 已经说出来、但没播完的话。
     *
     * 注意语义 —— 它裹的**不是**人类说的话，是 agent 自己说过、人类没听到的话，所以别把它
     * 和 `<asr-recognized-text>` 混成一类。放进给 agent 的文本前面用（见 brain-center）。
     *
     * 多行按这一家的老规矩：内容两侧各留一个换行、内容 trim 掉，让标签自己占一行。
     *
     * 名字和 reason 都是临时的（reason 目前写死"用户打断讲话"）。
     */
    unheardText(unheard: string) {
        if (unheard.includes("\n") || unheard.includes("\r")) {
            return `<unheard_text reason="用户打断讲话">\n${unheard.trim()}\n</unheard_text>`
        }
        return `<unheard_text reason="用户打断讲话">${unheard}</unheard_text>`
    }
}

export class SizedQueueOps {
    static push<T>(arr: T[], item: T, size: number) {
        if (arr.length >= size) {
            arr.shift();
        }
        arr.push(item);
    }

    static removeByIdentity<T>(arr: T[], item: T) {
        const index = arr.findIndex(x => x === item);
        if (index !== -1) {
            arr.splice(index, 1);
        }
    }
}