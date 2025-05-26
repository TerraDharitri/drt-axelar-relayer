import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AccountOnNetwork, ProxyNetworkProvider, TransactionStatus } from '@terradharitri/sdk-network-providers/out';
import { MessageApprovedProcessorModule, MessageApprovedProcessorService } from '../src/message-approved-processor';
import { MessageApprovedRepository } from '@drt-monorepo/common/database/repository/message-approved.repository';
import { PrismaService } from '@drt-monorepo/common/database/prisma.service';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { Transaction, TransactionWatcher } from '@terradharitri/sdk-core/out';
import { BinaryUtils } from '@terradharitri/sdk-nestjs-common';
import { AbiCoder } from 'ethers';
import { MessageApproved, MessageApprovedStatus } from '@prisma/client';
import { AxelarGmpApi } from '@drt-monorepo/common';

const WALLET_SIGNER_ADDRESS = 'drt1fsk0cnaag2m78gunfddsvg0y042rf0maxxgz6kvm32kxcl25m0yq6vxy04';

describe('MessageApprovedProcessorService', () => {
  let proxy: DeepMocked<ProxyNetworkProvider>;
  let transactionWatcher: DeepMocked<TransactionWatcher>;
  let axelarGmpApi: DeepMocked<AxelarGmpApi>;
  let prisma: PrismaService;
  let messageApprovedRepository: MessageApprovedRepository;

  let service: MessageApprovedProcessorService;

  let app: INestApplication;

  beforeEach(async () => {
    proxy = createMock();
    transactionWatcher = createMock();
    axelarGmpApi = createMock();

    const moduleRef = await Test.createTestingModule({
      imports: [MessageApprovedProcessorModule],
    })
      .overrideProvider(ProxyNetworkProvider)
      .useValue(proxy)
      .overrideProvider(TransactionWatcher)
      .useValue(transactionWatcher)
      .overrideProvider(AxelarGmpApi)
      .useValue(axelarGmpApi)
      .compile();

    prisma = await moduleRef.get(PrismaService);
    messageApprovedRepository = await moduleRef.get(MessageApprovedRepository);

    service = await moduleRef.get(MessageApprovedProcessorService);

    // Mock general calls
    proxy.getAccount.mockReturnValue(
      Promise.resolve(
        new AccountOnNetwork({
          nonce: 1,
        }),
      ),
    );
    proxy.doPostGeneric.mockImplementation((url: string): Promise<any> => {
      if (url === 'transaction/cost') {
        return Promise.resolve({
          txGasUnits: 10_000_000,
        });
      }

      return Promise.resolve(null);
    });

    proxy.getNetworkConfig.mockImplementation((): Promise<any> => {
      return Promise.resolve({
        MinGasPrice: 1000000000,
        MinGasLimit: 50000,
        GasPerDataByte: 1500,
        GasPriceModifier: 0.01,
      });
    });

    // Reset database & cache
    await prisma.messageApproved.deleteMany();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await prisma.$disconnect();

    await app.close();
  });

  const createMessageApproved = async (extraData: Partial<MessageApproved> = {}): Promise<MessageApproved> => {
    await messageApprovedRepository.createOrUpdate({
      sourceAddress: 'sourceAddress',
      messageId: 'messageId',
      status: MessageApprovedStatus.PENDING,
      sourceChain: 'ethereum',
      contractAddress: 'drt1qqqqqqqqqqqqqpgqzqvm5ywqqf524efwrhr039tjs29w0qltkklsqnrz4q',
      payloadHash: 'ebc84cbd75ba5516bf45e7024a9e12bc3c5c880f73e3a5beca7ebba52b2867a7',
      payload: Buffer.from('payload'),
      retry: 0,
      executeTxHash: null,
      updatedAt: new Date(),
      createdAt: new Date(),
      availableGasBalance: '0',
      ...extraData,
    });

    // @ts-ignore
    return await prisma.messageApproved.findUnique({
      where: {
        sourceChain_messageId: {
          sourceChain: extraData.sourceChain || 'ethereum',
          messageId: extraData.messageId || 'messageId',
        },
      },
    });
  };

  const assertArgs = (transaction: Transaction, entry: MessageApproved) => {
    const args = transaction.getData().toString().split('@');

    expect(args[0]).toBe('execute');
    expect(args[1]).toBe(BinaryUtils.stringToHex(entry.sourceChain));
    expect(args[2]).toBe(BinaryUtils.stringToHex(entry.messageId));
    expect(args[3]).toBe(BinaryUtils.stringToHex(entry.sourceAddress));
    expect(args[4]).toBe(entry.payload.toString('hex'));
  };

  it('Should send execute transaction two initial', async () => {
    const originalFirstEntry = await createMessageApproved({
      availableGasBalance: '1200000000000000',
    });
    const originalSecondEntry = await createMessageApproved({
      sourceChain: 'polygon',
      messageId: 'messageId2',
      sourceAddress: 'otherSourceAddress',
      payload: Buffer.from('otherPayload'),
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(2);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // Assert transactions data is correct
    const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
    expect(transactions).toHaveLength(2);

    expect(transactions[0].getGasLimit()).toBe(11_000_000); // 10% over 10_000_000
    expect(transactions[0].getNonce()).toBe(1);
    expect(transactions[0].getChainID()).toBe('test');
    expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
    assertArgs(transactions[0], originalFirstEntry);

    expect(transactions[1].getGasLimit()).toBe(11_000_000);
    expect(transactions[1].getNonce()).toBe(2);
    expect(transactions[1].getChainID()).toBe('test');
    expect(transactions[1].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
    assertArgs(transactions[1], originalSecondEntry);

    // No contract call approved pending
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      retry: 1,
      executeTxHash: 'c88655781e5d1908a6fc4b3efc46d2056870dfdfc38403988cd82cd2d346b723',
      updatedAt: expect.any(Date),
    });

    const secondEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalSecondEntry.sourceChain,
      originalSecondEntry.messageId,
    );
    expect(secondEntry).toEqual({
      ...originalSecondEntry,
      retry: 1,
      executeTxHash: 'db6fb8671b08c5b1a310285b700d52c8712473de798591a06785cce479568127',
      updatedAt: expect.any(Date),
    });
  });

  it('Should send execute transaction retry one processed one failed', async () => {
    // Entries will be processed
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '1200000000000000',
    });
    const originalSecondEntry = await createMessageApproved({
      sourceChain: 'polygon',
      messageId: 'messageId2',
      sourceAddress: 'otherSourceAddress',
      payload: Buffer.from('otherPayload'),
      retry: 3,
      updatedAt: new Date(new Date().getTime() - 60_500),
      taskItemId: '0191ead2-2234-7310-b405-76e787415031',
      availableGasBalance: '1200000000000000',
    });
    // Entry will not be processed (updated too early)
    const originalThirdEntry = await createMessageApproved({
      messageId: 'messageId3',
      retry: 1,
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });

    axelarGmpApi.postEvents.mockImplementation(() => {
      return Promise.resolve();
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // Assert transactions data is correct
    const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
    expect(transactions).toHaveLength(1);

    expect(transactions[0].getGasLimit()).toBe(13_000_000); // 10% + 20% over 10_000_000
    expect(transactions[0].getNonce()).toBe(1);
    expect(transactions[0].getChainID()).toBe('test');
    expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
    assertArgs(transactions[0], originalFirstEntry);

    // No contract call approved pending remained
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      retry: 2,
      executeTxHash: 'c3c7ded4dd5fa11de3f0c9fcc8f4368435f6e112d12563afde1f788d414b670f',
      updatedAt: expect.any(Date),
    });

    const secondEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalSecondEntry.sourceChain,
      originalSecondEntry.messageId,
    );
    expect(secondEntry).toEqual({
      ...originalSecondEntry,
      status: MessageApprovedStatus.FAILED,
      updatedAt: expect.any(Date),
    });

    expect(axelarGmpApi.postEvents).toHaveBeenCalledTimes(1);
    // @ts-ignore
    expect(axelarGmpApi.postEvents.mock.lastCall[0][0]).toEqual({
      type: 'CANNOT_EXECUTE_MESSAGE/V2',
      eventID: originalSecondEntry?.messageId,
      messageID: originalSecondEntry?.messageId,
      sourceChain: 'dharitri',
      reason: 'ERROR',
      details: 'retried 3 times',
      meta: {
        txID: null,
        taskItemID: originalSecondEntry.taskItemId,
      },
    });

    // Was not updated
    const thirdEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalThirdEntry.sourceChain,
      originalThirdEntry.messageId,
    );
    expect(thirdEntry).toEqual({
      ...originalThirdEntry,
    });
  });

  it('Should send execute transaction not successfully sent', async () => {
    const originalFirstEntry = await createMessageApproved({
      availableGasBalance: '1200000000000000',
    });
    const originalSecondEntry = await createMessageApproved({
      sourceChain: 'polygon',
      messageId: 'messageId2',
      sourceAddress: 'otherSourceAddress',
      payload: Buffer.from('otherPayload'),
      retry: 2,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((): Promise<string[]> => {
      return Promise.resolve([]);
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(2);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // Assert transactions data is correct
    const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
    expect(transactions).toHaveLength(2);

    assertArgs(transactions[0], originalFirstEntry);
    assertArgs(transactions[1], originalSecondEntry);

    // 2 are still pending because of proxy error
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database to NOT be updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      retry: 1, // retry is set to 1
      updatedAt: expect.any(Date),
    });

    const secondEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalSecondEntry.sourceChain,
      originalSecondEntry.messageId,
    );
    expect(secondEntry).toEqual({
      ...originalSecondEntry,
      retry: 2, // retry stays the same
      updatedAt: expect.any(Date),
    });
  });

  function mockProxySendTransactionsSuccess() {
    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });
  }

  it('Should send execute transaction do not retry on gas failure', async () => {
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '1200000000000000',
    });

    proxy.sendTransactions.mockImplementation((transactions): Promise<string[]> => {
      return Promise.resolve(transactions.map((transaction: any) => transaction.getHash().toString() as string));
    });
    proxy.doPostGeneric.mockImplementation((): Promise<any> => {
      // Mock gas error
      return Promise.resolve(null);
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    // Transaction is sent even though it will fail
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

    // No contract call approved pending remained for now
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      executeTxHash: 'e39f6be7c74340deea8b89fa34a39220c2f19e64966df45e9b1bd9582109c649',
      retry: 3,
      updatedAt: expect.any(Date),
    });
  });

  it('Should not send execute transaction if not enough gas', async () => {
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '300000000000000', // Not enough gas
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(0);

    // No contract call approved pending remained for now
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      status: 'FAILED',
      retry: 3,
      updatedAt: expect.any(Date),
    });

    expect(axelarGmpApi.postEvents).toHaveBeenCalledTimes(1);
    // @ts-ignore
    expect(axelarGmpApi.postEvents.mock.lastCall[0][0]).toEqual({
      type: 'CANNOT_EXECUTE_MESSAGE/V2',
      eventID: firstEntry?.messageId,
      messageID: firstEntry?.messageId,
      sourceChain: 'dharitri',
      reason: 'INSUFFICIENT_GAS',
      details: 'retried 3 times',
      meta: {
        txID: null,
        taskItemID: '',
      },
    });
  });

  it('Should not send execute transaction if not enough gas negative', async () => {
    const originalFirstEntry = await createMessageApproved({
      retry: 1,
      updatedAt: new Date(new Date().getTime() - 60_500),
      availableGasBalance: '-300000000000000', // Not enough gas negative
    });

    await service.processPendingMessageApproved();

    expect(proxy.getAccount).toHaveBeenCalledTimes(1);
    expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
    expect(proxy.sendTransactions).toHaveBeenCalledTimes(0);

    // No contract call approved pending remained for now
    expect(await messageApprovedRepository.findPending()).toEqual([]);

    // Expect entries in database updated
    const firstEntry = await messageApprovedRepository.findBySourceChainAndMessageId(
      originalFirstEntry.sourceChain,
      originalFirstEntry.messageId,
    );
    expect(firstEntry).toEqual({
      ...originalFirstEntry,
      status: 'FAILED',
      retry: 3,
      updatedAt: expect.any(Date),
    });
  });

  describe('ITS execute', () => {
    const contractAddress = 'drt1qqqqqqqqqqqqqpgq97wezxw6l7lgg7k9rxvycrz66vn92ksh2tssmj7a6l';

    it('Should send execute transaction one deploy interchain token one other', async () => {
      const originalItsExecuteOther = await createMessageApproved({
        contractAddress,
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [0]).substring(2), 'hex'),
        availableGasBalance: '1200000000000000',
      });
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [1]).substring(2), 'hex'),
        availableGasBalance: '1200000000000000',
      });

      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      expect(proxy.getAccount).toHaveBeenCalledTimes(1);
      expect(proxy.doPostGeneric).toHaveBeenCalledTimes(2);
      expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

      // Assert transactions data is correct
      const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(2);

      expect(transactions[0].getGasLimit()).toBe(11_000_000); // 10% over 10_000_000
      expect(transactions[0].getNonce()).toBe(1);
      expect(transactions[0].getChainID()).toBe('test');
      expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
      assertArgs(transactions[0], originalItsExecuteOther);
      expect(transactions[0].getValue()).toBe(0n); // assert sent with value 0

      expect(transactions[1].getGasLimit()).toBe(11_000_000);
      expect(transactions[1].getNonce()).toBe(2);
      expect(transactions[1].getChainID()).toBe('test');
      expect(transactions[1].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
      assertArgs(transactions[1], originalItsExecute);
      expect(transactions[1].getValue()).toBe(0n); // assert sent with value 0

      // No contract call approved pending
      expect(await messageApprovedRepository.findPending()).toEqual([]);

      // Expect entries in database updated
      const itsExecuteOther = await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecuteOther.sourceChain,
        originalItsExecuteOther.messageId,
      );
      expect(itsExecuteOther).toEqual({
        ...originalItsExecuteOther,
        retry: 1,
        executeTxHash: '999ac03183b4aac45bd0c1fbccab3637a7fd2f4bbc275e7f4b7efcab3cc7e0de',
        updatedAt: expect.any(Date),
        successTimes: null,
      });

      const itsExecute = await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      );
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 1,
        executeTxHash: '6b2b236dece2b0fa5c189575245bc2761d9e07a1e6268597147e582eb1473515',
        updatedAt: expect.any(Date),
        successTimes: null,
      });
    });

    it('Should send execute transaction deploy interchain token 2 times', async () => {
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [1]).substring(2), 'hex'),
        availableGasBalance: '51200000000000000', // also contains 0.05 REWA for DCDT issue
      });

      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      expect(proxy.getAccount).toHaveBeenCalledTimes(1);
      expect(proxy.doPostGeneric).toHaveBeenCalledTimes(1);
      expect(proxy.sendTransactions).toHaveBeenCalledTimes(1);

      // Assert transactions data is correct
      let transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);

      expect(transactions[0].getGasLimit()).toBe(11_000_000);
      expect(transactions[0].getNonce()).toBe(1);
      expect(transactions[0].getChainID()).toBe('test');
      expect(transactions[0].getSender().bech32()).toBe(WALLET_SIGNER_ADDRESS);
      assertArgs(transactions[0], originalItsExecute);
      expect(transactions[0].getValue()).toBe(0n); // assert sent with no value 1st time

      // No contract call approved pending
      expect(await messageApprovedRepository.findPending()).toEqual([]);

      // @ts-ignore
      let itsExecute: MessageApproved = await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      );
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 1,
        executeTxHash: 'f2eb89f60c4d611823c9f221f3b0fcd2dc11b8ed01aa4c8c9e2908622779a2c5',
        updatedAt: expect.any(Date),
        successTimes: null,
      });

      // Mark as last updated more than 1 minute ago
      itsExecute.updatedAt = new Date(new Date().getTime() - 60_500);
      await prisma.messageApproved.update({
        where: {
          sourceChain_messageId: {
            sourceChain: itsExecute.sourceChain,
            messageId: itsExecute.messageId,
          },
        },
        data: itsExecute,
      });

      // Mock 1st transaction executed successfully
      transactionWatcher.awaitCompleted.mockReturnValueOnce(
        // @ts-ignore
        Promise.resolve({
          ...transactions[0],
          status: new TransactionStatus('success'),
        }),
      );

      // Process transaction 2nd time
      await service.processPendingMessageApproved();

      transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value 2nd time

      itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 2,
        executeTxHash: 'b2e6cc677b02b1268061e851a08d07f36207dfe3a30ad9dd0472ed54805e7b99',
        updatedAt: expect.any(Date),
        successTimes: 1,
      });

      // Mark as last updated more than 1 minute ago
      itsExecute.updatedAt = new Date(new Date().getTime() - 60_500);
      await prisma.messageApproved.update({
        where: {
          sourceChain_messageId: {
            sourceChain: itsExecute.sourceChain,
            messageId: itsExecute.messageId,
          },
        },
        data: itsExecute,
      });

      // Process transaction 3rd time will retry transaction not sent
      proxy.sendTransactions.mockReturnValueOnce(Promise.resolve([]));

      await service.processPendingMessageApproved();

      transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value

      itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 2,
        executeTxHash: null,
        updatedAt: expect.any(Date),
        successTimes: 1,
      });

      // Mark as last updated more than 1 minute ago
      itsExecute.updatedAt = new Date(new Date().getTime() - 60_500);
      await prisma.messageApproved.update({
        where: {
          sourceChain_messageId: {
            sourceChain: itsExecute.sourceChain,
            messageId: itsExecute.messageId,
          },
        },
        data: itsExecute,
      });

      // Process transaction 3rd time will retry transaction sent
      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value

      itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 3,
        executeTxHash: 'ef05047f045cc3769eaa31130ce1efa4c558367df7920327b57d9350ed123dfd',
        updatedAt: expect.any(Date),
        successTimes: 1,
      });
    });

    it('Should send execute transaction deploy interchain token ITS Hub payload', async () => {
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(
          AbiCoder.defaultAbiCoder()
            .encode(
              ['uint256', 'string', 'bytes'],
              [4, 'ethereum', AbiCoder.defaultAbiCoder().encode(['uint256'], [1])],
            )
            .substring(2),
          'hex',
        ),
        availableGasBalance: '51200000000000000', // also contains 0.05 REWA for DCDT issue
        executeTxHash: 'f2eb89f60c4d611823c9f221f3b0fcd2dc11b8ed01aa4c8c9e2908622779a2c5',
        successTimes: 1,
      });

      // Mock 1st transaction executed successfully
      transactionWatcher.awaitCompleted.mockReturnValueOnce(
        // @ts-ignore
        Promise.resolve({
          status: new TransactionStatus('success'),
        }),
      );

      mockProxySendTransactionsSuccess();

      await service.processPendingMessageApproved();

      const transactions = proxy.sendTransactions.mock.lastCall?.[0] as Transaction[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0].getValue()).toBe(50000000000000000n); // assert sent with value

      const itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 1,
        executeTxHash: 'cbc16f8dbd374740dd56b3aa420ff2edf83faa66c42297a5d084dd5171e03772',
        updatedAt: expect.any(Date),
        successTimes: 1,
      });
    });

    it('Should send execute transaction deploy interchain token only deploy dcdt not enough fee', async () => {
      const originalItsExecute = await createMessageApproved({
        contractAddress,
        sourceChain: 'polygon',
        sourceAddress: 'otherSourceAddress',
        payload: Buffer.from(AbiCoder.defaultAbiCoder().encode(['uint256'], [1]).substring(2), 'hex'),
        retry: 1,
        executeTxHash: 'f2eb89f60c4d611823c9f221f3b0fcd2dc11b8ed01aa4c8c9e2908622779a2c5',
        successTimes: 1,
        availableGasBalance: '1200000000000000', // not enough fee for paying 0.05 REWA for DCDT issue
        updatedAt: new Date(new Date().getTime() - 60_500),
      });

      // Process transaction for DCDT issue only
      await service.processPendingMessageApproved();

      expect(proxy.sendTransactions).toHaveBeenCalledTimes(0);

      const itsExecute = (await messageApprovedRepository.findBySourceChainAndMessageId(
        originalItsExecute.sourceChain,
        originalItsExecute.messageId,
      )) as MessageApproved;
      expect(itsExecute).toEqual({
        ...originalItsExecute,
        retry: 3,
        status: 'FAILED',
        updatedAt: expect.any(Date),
      });
    });
  });
});
