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