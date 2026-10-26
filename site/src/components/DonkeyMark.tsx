type Props = {
  alt?: string;
};

/** The donkey mark. In dark mode it sits on a white tile so the dark artwork
 * keeps its contrast. */
export function DonkeyMark({ alt = "" }: Props) {
  return (
    <span className="block size-full rounded-[22%] dark:bg-white dark:p-[12%]">
      <img src="/donkey-logo.svg" alt={alt} width={264} height={318} className="block h-full w-full object-contain" />
    </span>
  );
}
