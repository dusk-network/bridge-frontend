import { createDuskWallet } from "@dusk/connect";

export const createDuskConnection = async () => {
  const wallet = createDuskWallet();

  await wallet.ready();

  return {
    connect: () =>
      wallet.connect({
        reason: "payment_request",
        shieldedReceiveAddress: true,
      }),
    disconnect: () => wallet.disconnect(),
    get state() {
      return wallet.state;
    },
    subscribe: (listener) => wallet.subscribe(listener),
  };
};

